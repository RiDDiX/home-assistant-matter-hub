import type {
  EntityMappingConfig,
  HomeAssistantEntityRegistry,
} from "@home-assistant-matter-hub/common";
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
  // current build pass or on a live endpoint.
  isEndpointIdTaken(endpointId: string, key: string): boolean;
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

  async resolveIdentity(
    bridgeId: string,
    entity: IdentityEntity,
    mapping: EntityMappingConfig | undefined,
    opts: ResolveOptions,
  ): Promise<ResolvedIdentity> {
    const entityId = entity.entity_id;
    const key = identityKey(entity);

    // FLOW 3: no stable key, keep today's entity_id derivation, no record.
    if (key == null) {
      return {
        endpointId: createEndpointId(entityId, mapping?.customName),
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
        // A rename records the new entity_id and carries the mapping across; the
        // endpoint id and anchor stay frozen.
        if (renamedFrom) {
          this.identityStorage.setIdentity(bridgeId, key, {
            ...existing,
            lastEntityId: entityId,
          });
          await this.rekeyMapping(bridgeId, renamedFrom, entityId);
        }
        return {
          endpointId: existing.endpointId,
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
    if (opts.stableIdentity) {
      // Only make unique when the frozen id will actually be used, so a record
      // seeded while the flag is off stays identical to today's derivation.
      let n = 2;
      while (opts.isEndpointIdTaken(endpointId, key)) {
        endpointId = `${desired}_${n++}`;
      }
    }
    const record: IdentityRecord = {
      endpointId,
      anchorEntityId: entityId,
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

  // Carry a mapping from the old entity_id to the new one on rename. anchorEntityId
  // never changes, only the mapping key. Skips when no old mapping exists or a new
  // one already does, so a manual mapping under the new id is never clobbered.
  private async rekeyMapping(
    bridgeId: string,
    oldEntityId: string,
    newEntityId: string,
  ): Promise<void> {
    if (oldEntityId === newEntityId) {
      return;
    }
    const old = this.mappingStorage.getMapping(bridgeId, oldEntityId);
    if (!old) {
      return;
    }
    if (this.mappingStorage.getMapping(bridgeId, newEntityId)) {
      return;
    }
    await this.mappingStorage.setMapping({
      ...old,
      bridgeId,
      entityId: newEntityId,
    });
    await this.mappingStorage.deleteMapping(bridgeId, oldEntityId);
  }
}
