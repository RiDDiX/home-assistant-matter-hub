import type {
  EntityMappingConfig,
  HomeAssistantEntityRegistry,
} from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import { createEndpointId } from "../../matter/endpoints/entity-endpoint.js";
import type {
  EntityIdentityStorage,
  IdentityRecord,
} from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";

// Only entity_id and the registry are needed to key an identity.
export interface IdentityEntity {
  entity_id: string;
  registry?: HomeAssistantEntityRegistry;
}

export interface ResolvedIdentity {
  endpointId: string;
  anchorEntityId: string;
  protected: boolean;
  // set when a FLOW 1 rename was detected, so the caller can move its in-memory
  // fingerprint entry from the old entity id to the new one.
  renamedFrom?: string;
}

export interface ResolveOptions {
  stableIdentity: boolean;
  // true when a DIFFERENT identity already claims this endpoint id in the
  // current build pass. A keyless entity (key null) only yields to a keyed
  // one.
  isEndpointIdTaken(endpointId: string, key: string | null): boolean;
  // resolveIdentities re-keyed the whole pass already, a second move per
  // entity would carry a mapping on into a slot the batch just freed
  mappingsRekeyed?: boolean;
}

// NUL separates the parts so an entity_id or platform value can never forge
// another entity's key.
const SEP = "\u0000";

// Stable key for an entity: the HA entity registry unique_id scoped by platform
// and domain. Returns null when the entity has no registry unique_id/platform,
// which keeps such entities on the legacy entity_id derivation (FLOW 3).
export function identityKey(entity: IdentityEntity): string | null {
  const uniqueId = entity.registry?.unique_id;
  const platform = entity.registry?.platform;
  if (!uniqueId || !platform) {
    return null;
  }
  const domain = entity.entity_id.split(".")[0];
  return platform + SEP + domain + SEP + uniqueId;
}

/**
 * Resolves the stable endpoint id and identity anchor for an entity.
 *
 * Seeding is unconditional: even with stableIdentity off, the first sighting of
 * a keyed entity writes a record capturing today's derivation, and while off the
 * record is kept in lock-step with the live legacy derivation (re-seeded on a
 * rename or customName change). Consumption of the frozen identity, and the
 * mapping re-key that goes with it, are gated behind the flag, so flipping it on
 * later works off a fully seeded map and never re-mints an existing device.
 */
export class IdentityResolver {
  constructor(
    private readonly identityStorage: EntityIdentityStorage,
    private readonly mappingStorage: EntityMappingStorage,
  ) {}

  // Resolves one build pass in the given order. With the flag on, every id
  // frozen for an entity of this pass is reserved up front (the entity mounted
  // at it wins, else the first record in order), so neither a new key nor a
  // keyless entity takes it whatever the order. mounted maps entity_id to the
  // endpoint id it is mounted at now.
  async resolveIdentities(
    bridgeId: string,
    entities: IdentityEntity[],
    getMapping: (entityId: string) => EntityMappingConfig | undefined,
    stableIdentity: boolean,
    log: Logger,
    mounted?: ReadonlyMap<string, string>,
  ): Promise<Map<string, ResolvedIdentity>> {
    const owners = new Map<string, { key: string | null; entityId: string }>();
    const frozenIds = new Map<string, string>();
    const renames: [string, string][] = [];
    if (stableIdentity) {
      for (const entity of entities) {
        const key = identityKey(entity);
        const existing =
          key == null
            ? undefined
            : this.identityStorage.getIdentity(bridgeId, key);
        if (key == null || !existing) continue;
        frozenIds.set(entity.entity_id, existing.endpointId);
        // The mounted entity keeps a shared id, else the file and the node
        // disagree and the two swap numbers on the next restart (#543).
        if (
          !owners.has(existing.endpointId) ||
          mounted?.get(entity.entity_id) === existing.endpointId
        ) {
          owners.set(existing.endpointId, { key, entityId: entity.entity_id });
        }
        const from = existing.lastEntityId ?? existing.anchorEntityId;
        if (from !== entity.entity_id) renames.push([from, entity.entity_id]);
      }
      await this.rekeyMappings(bridgeId, renames);
    }
    const resolved = new Map<string, ResolvedIdentity>();
    for (const entity of entities) {
      const res = await this.resolveIdentity(
        bridgeId,
        entity,
        getMapping(entity.entity_id),
        {
          stableIdentity,
          isEndpointIdTaken: (id, key) =>
            owners.has(id) && owners.get(id)?.key !== key,
          mappingsRekeyed: true,
        },
      );
      resolved.set(entity.entity_id, res);
      const frozen = frozenIds.get(entity.entity_id);
      if (frozen != null && res.endpointId !== frozen) {
        log.warn(
          `${entity.entity_id} shares endpoint id ${frozen} with ${owners.get(frozen)?.entityId}, moved it to ${res.endpointId}`,
        );
      }
      if (!owners.has(res.endpointId)) {
        owners.set(res.endpointId, {
          key: identityKey(entity),
          entityId: entity.entity_id,
        });
      }
    }
    return resolved;
  }

  async resolveIdentity(
    bridgeId: string,
    entity: IdentityEntity,
    mapping: EntityMappingConfig | undefined,
    opts: ResolveOptions,
  ): Promise<ResolvedIdentity> {
    const entityId = entity.entity_id;
    const key = identityKey(entity);

    // FLOW 3: no stable key, keep today's entity_id derivation, no record.
    // With the flag on it still steps aside from an id a keyed entity holds.
    if (key == null) {
      const desired = createEndpointId(entityId, mapping?.customName);
      let endpointId = desired;
      let n = 2;
      while (opts.stableIdentity && opts.isEndpointIdTaken(endpointId, null)) {
        endpointId = `${desired}_${n++}`;
      }
      return {
        endpointId,
        anchorEntityId: entityId,
        protected: false,
      };
    }

    const existing = this.identityStorage.getIdentity(bridgeId, key);

    // FLOW 1: a record exists. With the flag on the frozen identity is consumed;
    // with it off the live legacy derivation is returned and the record is kept
    // in lock-step with it, so a later flip-on is always a no-op.
    if (existing) {
      const renamedFrom =
        existing.lastEntityId !== entityId
          ? (existing.lastEntityId ?? existing.anchorEntityId)
          : undefined;

      if (opts.stableIdentity) {
        // Another record can already hold the same frozen id; this one then
        // moves to the next free suffix so both devices mount.
        let endpointId = existing.endpointId;
        let n = 2;
        while (opts.isEndpointIdTaken(endpointId, key)) {
          endpointId = `${existing.endpointId}_${n++}`;
        }
        // A rename records the new entity_id and carries the mapping across; the
        // endpoint id and anchor stay frozen. Re-key first: a failed write then
        // leaves the record on the old entity_id and the next pass retries.
        if (renamedFrom && !opts.mappingsRekeyed) {
          await this.rekeyMappings(bridgeId, [[renamedFrom, entityId]]);
        }
        if (renamedFrom || endpointId !== existing.endpointId) {
          this.identityStorage.setIdentity(bridgeId, key, {
            ...existing,
            endpointId,
            lastEntityId: entityId,
          });
        }
        return {
          endpointId,
          anchorEntityId: existing.anchorEntityId,
          protected: true,
          renamedFrom,
        };
      }

      // Flag off: controllers see today's legacy derivation, so the record must
      // track it. Re-seed whenever it diverges (a rename, or a customName change
      // that moves the endpoint id), else a later flip-on would consume a stale
      // record and re-mint the live device.
      const liveEndpointId = createEndpointId(entityId, mapping?.customName);
      if (
        existing.endpointId !== liveEndpointId ||
        existing.anchorEntityId !== entityId ||
        existing.lastEntityId !== entityId
      ) {
        this.identityStorage.setIdentity(bridgeId, key, {
          ...existing,
          endpointId: liveEndpointId,
          anchorEntityId: entityId,
          lastEntityId: entityId,
        });
      }
      return {
        endpointId: liveEndpointId,
        anchorEntityId: entityId,
        protected: false,
        renamedFrom,
      };
    }

    // FLOW 2: first sight of a keyed entity, seed a record from today's
    // derivation. This is the migration: the first build after upgrade records
    // the current ids, so nothing re-mints.
    const desired = createEndpointId(entityId, mapping?.customName);
    let endpointId = desired;
    let anchorEntityId = entityId;
    if (opts.stableIdentity) {
      // Only make unique when the frozen id will actually be used, so a record
      // seeded while the flag is off stays identical to today's derivation.
      let n = 2;
      while (opts.isEndpointIdTaken(endpointId, key)) {
        endpointId = `${desired}_${n++}`;
      }
      // A renamed entity keeps its old anchor; only a re-pair on this entity_id may share it.
      const held = new Set(
        [...this.identityStorage.getBridgeIdentities(bridgeId).values()]
          .filter((r) => (r.lastEntityId ?? r.anchorEntityId) !== entityId)
          .map((r) => r.anchorEntityId),
      );
      for (let a = 2; held.has(anchorEntityId); a++) {
        anchorEntityId = `${entityId}_${a}`;
      }
    }
    const record: IdentityRecord = {
      endpointId,
      anchorEntityId,
      lastEntityId: entityId,
      createdAt: new Date().toISOString(),
    };
    this.identityStorage.setIdentity(bridgeId, key, record);

    if (opts.stableIdentity) {
      return {
        endpointId: record.endpointId,
        anchorEntityId: record.anchorEntityId,
        protected: true,
      };
    }
    return {
      endpointId: desired,
      anchorEntityId: entityId,
      protected: false,
    };
  }

  // Carry mappings from the old entity_ids to the new ones on rename. anchorEntityId
  // never changes, only the mapping key. Skips when no old mapping exists or a new
  // one already does, so a manual mapping under the new id is never clobbered,
  // unless that mapping itself moves away in the same batch. All old mappings are
  // read before any write, so two entities swapping entity_ids keep their own.
  private async rekeyMappings(
    bridgeId: string,
    renames: [string, string][],
  ): Promise<void> {
    let moves = renames.flatMap(([from, to]) => {
      const old =
        from === to
          ? undefined
          : this.mappingStorage.getMapping(bridgeId, from);
      return old ? [{ from, to, old }] : [];
    });
    for (let changed = true; changed; ) {
      const freed = new Set(moves.map((m) => m.from));
      const kept = moves.filter(
        (m) =>
          freed.has(m.to) || !this.mappingStorage.getMapping(bridgeId, m.to),
      );
      changed = kept.length !== moves.length;
      moves = kept;
    }
    const written = new Set(moves.map((m) => m.to));
    const before = [...new Set(moves.flatMap((m) => [m.from, m.to]))].map(
      (entityId) =>
        [entityId, this.mappingStorage.getMapping(bridgeId, entityId)] as const,
    );
    try {
      for (const { to, old } of moves) {
        await this.mappingStorage.setMapping({
          ...old,
          bridgeId,
          entityId: to,
        });
      }
      for (const { from } of moves) {
        if (!written.has(from)) {
          await this.mappingStorage.deleteMapping(bridgeId, from);
        }
      }
    } catch (e) {
      // The storage changes its memory before the file write that failed, so a
      // half done swap would be swapped back by the retry. Put every slot back.
      for (const [entityId, mapping] of before) {
        await (mapping
          ? this.mappingStorage.setMapping({ ...mapping, bridgeId, entityId })
          : this.mappingStorage.deleteMapping(bridgeId, entityId)
        ).catch(() => {});
      }
      throw e;
    }
  }
}
