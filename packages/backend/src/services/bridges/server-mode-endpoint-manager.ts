import type {
  EntityMappingConfig,
  FailedEntity,
  HomeAssistantDomain,
} from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import { Service } from "../../core/ioc/service.js";
import {
  createEndpointId,
  type EntityEndpoint,
} from "../../matter/endpoints/entity-endpoint.js";
import { LegacyEndpoint } from "../../matter/endpoints/legacy/legacy-endpoint.js";
import type { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { ServerModeVacuumEndpoint } from "../../matter/endpoints/server-mode-vacuum-endpoint.js";
import { isHeapUnderPressure } from "../../utils/log-memory.js";
import { subscribeEntities } from "../home-assistant/api/subscribe-entities.js";
import type { HomeAssistantClient } from "../home-assistant/home-assistant-client.js";
import type { HomeAssistantStates } from "../home-assistant/home-assistant-registry.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import {
  buildPresentEntityIds,
  buildPresentIdentityKeys,
  stampIdentityPresence,
  stampMappingPresence,
} from "../storage/orphan-cleanup.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import {
  ENDPOINT_REMOVAL_GRACE_MS,
  type PendingRemoval,
} from "./bridge-endpoint-manager.js";
import type { BridgeRegistry } from "./bridge-registry.js";
import { EntityMappingSync } from "./entity-mapping-sync.js";
import {
  IdentityResolver,
  identityKey,
  type ResolvedIdentity,
} from "./identity-resolver.js";

// Hard cap so a wildcard matcher cannot mint dozens of root endpoints (#301).
export const MAX_SERVER_MODE_DEVICES = 10;

interface ManagedEndpoint {
  endpoint: EntityEndpoint;
  fingerprint: string;
}

/**
 * ServerModeEndpointManager manages the device endpoints for server mode.
 * Unlike BridgeEndpointManager which uses an AggregatorEndpoint, this manager
 * adds devices directly to the ServerNode. One node can carry several flat
 * sibling endpoints (#301); the primary entity (first include matcher) drives
 * the node identity and the advertised device type.
 */
export class ServerModeEndpointManager extends Service {
  private entityIds: string[] = [];
  private unsubscribe?: () => void;
  private observingRequested = false;
  private _failedEntities: FailedEntity[] = [];
  private readonly endpoints = new Map<string, ManagedEndpoint>();
  // Identity inputs of the primary entity as last pushed to the root node,
  // so a rename re-runs it and an unchanged refresh does not (#467).
  private lastServerNodeIdentity?: string;
  private readonly mappingSync: EntityMappingSync;
  // Same grace as the aggregator manager: server mode deleted on the FIRST
  // refresh an entity was absent, so one partial HA snapshot re-minted the
  // device (#438).
  private readonly pendingRemovals = new Map<string, PendingRemoval>();
  private removalRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  // endpoint id -> entity that closed but may come back (disable). Its number
  // is still parked, so nobody else may mount on that id (#438).
  private readonly parkedEndpointIds = new Map<string, string>();
  // Bumped on every stop, so a refresh that was already running cannot arm a
  // timer on a bridge that has since stopped.
  private lifecycle = 0;

  get failedEntities(): FailedEntity[] {
    return this._failedEntities;
  }

  /** All device endpoints, primary first. */
  get devices(): EntityEndpoint[] {
    return [...this.endpoints.values()].map((entry) => entry.endpoint);
  }

  private readonly identityResolver: IdentityResolver;

  constructor(
    private readonly serverNode: ServerModeServerNode,
    private readonly client: HomeAssistantClient,
    private readonly registry: BridgeRegistry,
    private readonly mappingStorage: EntityMappingStorage,
    private readonly identityStorage: EntityIdentityStorage,
    private readonly dataProvider: BridgeDataProvider,
    private readonly log: Logger,
  ) {
    super("ServerModeEndpointManager");
    this.identityResolver = new IdentityResolver(
      identityStorage,
      mappingStorage,
    );
    this.mappingSync = new EntityMappingSync(
      registry,
      (entityId) => this.getEntityMapping(entityId),
      log,
    );
  }

  private getEntityMapping(entityId: string): EntityMappingConfig | undefined {
    return this.mappingStorage.getMapping(this.dataProvider.id, entityId);
  }

  override async dispose(): Promise<void> {
    this.stopObserving();
    if (this.removalRecheckTimer) {
      clearTimeout(this.removalRecheckTimer);
      this.removalRecheckTimer = null;
    }
    this.pendingRemovals.clear();

    // Close endpoints to free memory while preserving stored endpoint
    // numbers. Using delete() here would erase persisted endpoint numbers,
    // causing controllers to treat the device as new on the next restart.
    for (const [entityId, entry] of this.endpoints) {
      try {
        await entry.endpoint.close();
      } catch (e) {
        this.log.warn(
          `Failed to close endpoint ${entityId} during dispose:`,
          e,
        );
      }
    }
    this.endpoints.clear();
  }

  async startObserving(): Promise<void> {
    // Only the subscription resets here. stopObserving is the lifecycle stop
    // and would take the removal timer with it (#438).
    this.clearSubscription();
    // Wanting to observe and holding a subscription differ: a node started
    // while HA was down has no entities yet, and only this flag gets it
    // subscribed once the first trusted refresh brings them in.
    this.observingRequested = true;

    if (!this.entityIds.length) {
      return;
    }

    const subscriptionIds = this.collectSubscriptionEntityIds();
    this.unsubscribe = subscribeEntities(
      this.client.connection,
      (e) => this.updateStates(e),
      subscriptionIds,
    );
  }

  private collectSubscriptionEntityIds(): string[] {
    const ids = new Set(this.entityIds);
    for (const entry of this.endpoints.values()) {
      for (const mappedId of entry.endpoint.mappedEntityIds) {
        ids.add(mappedId);
      }
    }
    for (const id of this.mappingSync.candidateSensorIds()) {
      ids.add(id);
    }
    return [...ids];
  }

  private clearSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  stopObserving(): void {
    this.observingRequested = false;
    this.lifecycle++;
    this.clearSubscription();
    // Bridges stop through this, never through dispose(), so the recheck
    // timer has to die here or it refreshes a stopped node.
    if (this.removalRecheckTimer) {
      clearTimeout(this.removalRecheckTimer);
      this.removalRecheckTimer = null;
    }
    this.mappingSync.cancelRetry();
  }

  /** Primary first (the entity the first include matcher tests true for). */
  private orderEntityIds(ids: string[]): string[] {
    const firstMatcher = this.dataProvider.filter?.include?.[0];
    const primary = firstMatcher
      ? this.registry.firstEntityMatching(firstMatcher)
      : undefined;
    if (!primary || !ids.includes(primary)) {
      return [...ids];
    }
    return [primary, ...ids.filter((id) => id !== primary)];
  }

  private async removeEndpoints(entityIds: string[]): Promise<void> {
    for (const entityId of entityIds) {
      const entry = this.endpoints.get(entityId);
      if (!entry) continue;
      try {
        await entry.endpoint.delete();
      } catch (e) {
        this.log.warn(`Failed to delete endpoint ${entityId}:`, e);
      }
      this.serverNode.forgetDevice(entry.endpoint);
      this.endpoints.delete(entityId);
    }
  }

  // Absence-driven removals wait out the grace window AND a fresh successful
  // HA reload, so restarts and stale snapshots never erase numbers (#438).
  // Returns the ids whose absence is confirmed, ready for removeEndpoints.
  private removableAfterGrace(entityIds: string[]): string[] {
    const now = Date.now();
    const generation = this.registry.snapshotGeneration;
    const ready: string[] = [];
    for (const entityId of entityIds) {
      const entry = this.pendingRemovals.get(entityId);
      if (entry == null) {
        this.pendingRemovals.set(entityId, { since: now, generation });
        continue;
      }
      if (
        now - entry.since < ENDPOINT_REMOVAL_GRACE_MS ||
        now - this.client.runningSince < ENDPOINT_REMOVAL_GRACE_MS ||
        generation <= entry.generation
      ) {
        continue;
      }
      ready.push(entityId);
      this.pendingRemovals.delete(entityId);
    }
    return ready;
  }

  // refreshDevices only runs on registry-fingerprint changes, which may not
  // recur, so drive held removals to completion ourselves after the grace.
  private scheduleRemovalRecheck() {
    if (this.removalRecheckTimer) {
      clearTimeout(this.removalRecheckTimer);
      this.removalRecheckTimer = null;
    }
    if (this.pendingRemovals.size === 0) return;
    const lifecycle = this.lifecycle;
    this.removalRecheckTimer = setTimeout(() => {
      this.removalRecheckTimer = null;
      this.refreshDevices().catch((e) => {
        this.log.warn("Endpoint removal recheck failed:", e);
        // A failed refresh must not strand the held removals with no timer,
        // but a bridge that stopped meanwhile gets no new one.
        if (lifecycle === this.lifecycle) this.scheduleRemovalRecheck();
      });
    }, ENDPOINT_REMOVAL_GRACE_MS + 5_000);
  }

  // Like removeEndpoints but close() keeps the persisted number pre-allocated,
  // so a same-id recreate reuses it. Used on rename and same-id recreates (#404).
  private async closeEndpoint(entityId: string): Promise<void> {
    const entry = this.endpoints.get(entityId);
    if (!entry) return;
    try {
      await entry.endpoint.close();
    } catch (e) {
      // Still attached, so keep tracking it: dropping it here would hide the
      // endpoint id from the collision checks and the recreate would clash.
      this.log.warn(`Failed to close endpoint ${entityId}:`, e);
      return;
    }
    this.serverNode.forgetDevice(entry.endpoint);
    this.endpoints.delete(entityId);
  }

  async refreshDevices(): Promise<void> {
    this.registry.refresh();

    const lifecycle = this.lifecycle;
    const fullEntities = this.registry.fullEntities;

    try {
      // HA restarting or an empty registry means the snapshot cannot be
      // trusted, not that the device was removed. Deleting erases the Matter
      // number and controllers re-add it as new, losing groups, and stamping
      // tombstones from it would mark live entities missing (#438). Keep the
      // last good entity list and wait for HA.
      if (!this.client.haRunning || Object.keys(fullEntities).length === 0) {
        this.pendingRemovals.clear();
        this.log.warn(
          "HA not running or registry empty, deferring server mode reconcile",
        );
        return;
      }

      this._failedEntities = [];
      this.entityIds = this.registry.entityIds;

      // Reconcile orphan tombstones against the FULL HA registry before any
      // early return below, so a node whose only entity was removed still
      // tombstones its stored identity record. Keyed by the rename-stable
      // identity key, so a rename or a filter change never reads as a removal.
      stampIdentityPresence(
        this.identityStorage,
        this.dataProvider.id,
        buildPresentIdentityKeys(fullEntities),
      );
      // Same reconcile for stray custom mappings, keyed by entity_id: it
      // catches a flag-off rename that left the mapping at the old id and
      // keyless entities that have no identity record.
      stampMappingPresence(
        this.mappingStorage,
        this.dataProvider.id,
        buildPresentEntityIds(fullEntities),
      );

      if (this.entityIds.length === 0) {
        this.log.warn("Server mode bridge has no entities configured");
        await this.removeEndpoints(
          this.removableAfterGrace([...this.endpoints.keys()]),
        );
        // surface the empty node in the UI instead of running silently
        this._failedEntities.push({
          entityId:
            this.dataProvider.filter?.include?.[0]?.value ??
            "(no entity configured)",
          reason:
            "No Home Assistant entity matched this bridge's filter. Check for typos or renamed/removed entities.",
        });
        return;
      }

      const orderedIds = this.orderEntityIds(this.entityIds);
      const surplus = orderedIds.splice(MAX_SERVER_MODE_DEVICES);
      for (const entityId of surplus) {
        this._failedEntities.push({
          entityId,
          reason: `Server mode exposes at most ${MAX_SERVER_MODE_DEVICES} devices per node. Remove extra entities or create another standalone device.`,
        });
      }
      if (surplus.length > 0) {
        this.log.warn(
          `Server mode node is capped at ${MAX_SERVER_MODE_DEVICES} devices, ${surplus.length} entities skipped`,
        );
      }

      // Phase 0: resolve stable identities up front so a rename maps to its
      // existing endpoint id and keeps the device number (#404).
      const stableIdentity =
        this.dataProvider.featureFlags?.stableIdentity === true;
      const resolvedByEntity = new Map<string, ResolvedIdentity>();
      const endpointIdToEntity = new Map<string, string>();
      const claimedEndpointIds = new Map<string, string>();
      for (const entityId of orderedIds) {
        const entityInfo = {
          entity_id: entityId,
          registry: this.registry.entity(entityId),
        };
        const resolved = await this.identityResolver.resolveIdentity(
          this.dataProvider.id,
          entityInfo,
          this.getEntityMapping(entityId),
          {
            stableIdentity,
            isEndpointIdTaken: (id, key) =>
              claimedEndpointIds.has(id) && claimedEndpointIds.get(id) !== key,
          },
        );
        resolvedByEntity.set(entityId, resolved);
        claimedEndpointIds.set(
          resolved.endpointId,
          identityKey(entityInfo) ?? `\u0000e:${entityId}`,
        );
        endpointIdToEntity.set(resolved.endpointId, entityId);
      }

      // drop endpoints whose entity no longer matches the filter. A rename keeps
      // its endpoint id under a different entity, so close() (keep number)
      // instead of delete() (frees number) for those (#404).
      const keep = new Set(orderedIds);
      for (const id of keep) {
        this.pendingRemovals.delete(id);
      }
      const removed = [...this.endpoints.keys()].filter((id) => !keep.has(id));
      const genuinelyRemoved: string[] = [];
      for (const oldId of removed) {
        const entry = this.endpoints.get(oldId);
        const claimant = entry
          ? endpointIdToEntity.get(entry.endpoint.id)
          : undefined;
        if (entry && claimant != null && claimant !== oldId) {
          await this.closeEndpoint(oldId);
          // the absence resolved as a rename, drop any pending stamp
          this.pendingRemovals.delete(oldId);
        } else {
          genuinelyRemoved.push(oldId);
        }
      }
      const confirmedRemoved = this.removableAfterGrace(genuinelyRemoved);
      let structureChanged =
        removed.length > genuinelyRemoved.length || confirmedRemoved.length > 0;
      await this.removeEndpoints(confirmedRemoved);

      // Reserve every disabled entity's id up front: an active entity that
      // sorts earlier would otherwise mount on it first and inherit its
      // persisted number (#438).
      for (const entityId of orderedIds) {
        const mapping = this.getEntityMapping(entityId);
        if (!mapping?.disabled) continue;
        // Drop this entity's older reservations first: a customName edit
        // while disabled moves the id and the stale one would block others.
        for (const [id, owner] of this.parkedEndpointIds) {
          if (owner === entityId) this.parkedEndpointIds.delete(id);
        }
        this.parkedEndpointIds.set(
          this.endpoints.get(entityId)?.endpoint.id ??
            resolvedByEntity.get(entityId)?.endpointId ??
            createEndpointId(entityId, mapping.customName),
          entityId,
        );
      }

      for (const entityId of orderedIds) {
        const mapping = this.getEntityMapping(entityId);

        if (mapping?.disabled) {
          this.log.warn(
            `Entity in server mode bridge is disabled: ${entityId}`,
          );
          // Disabling is reversible, so close() keeps the number, the way
          // plugin disable does (#439, #438). The id was reserved above.
          if (this.endpoints.has(entityId)) {
            await this.closeEndpoint(entityId);
            structureChanged = true;
          }
          this._failedEntities.push({
            entityId,
            reason: "The configured entity is disabled for this bridge.",
          });
          continue;
        }

        const existing = this.endpoints.get(entityId);
        if (
          existing &&
          existing.fingerprint ===
            this.mappingSync.compareFingerprint(
              mapping,
              entityId,
              existing.fingerprint,
            )
        ) {
          this.log.debug(`Device endpoint already exists for ${entityId}`);
          continue;
        }
        const resolved = resolvedByEntity.get(entityId);
        if (existing) {
          this.log.info(`Mapping changed for ${entityId}, recreating endpoint`);
          // Keep the number when the id is unchanged (protected entity, or a
          // customName edit that does not move the frozen id) (#404).
          if (resolved && existing.endpoint.id === resolved.endpointId) {
            await this.closeEndpoint(entityId);
          } else {
            await this.removeEndpoints([entityId]);
          }
          structureChanged = true;
        }

        // already exposed through another endpoint's mapped entities
        // (e.g. the vacuum auto-claims its battery and mode selects)
        const claimedBy = [...this.endpoints.entries()].find(([, entry]) =>
          entry.endpoint.mappedEntityIds.includes(entityId),
        );
        if (claimedBy) {
          this._failedEntities.push({
            entityId,
            reason: `Already exposed through ${claimedBy[0]} on this node.`,
          });
          continue;
        }

        // matter.js rejects duplicate endpoint ids at startup
        const endpointId =
          resolved?.endpointId ??
          createEndpointId(entityId, mapping?.customName);
        const collision = [...this.endpoints.entries()].find(
          ([, entry]) => entry.endpoint.id === endpointId,
        );
        const parkedBy = this.parkedEndpointIds.get(endpointId);
        if (collision || (parkedBy != null && parkedBy !== entityId)) {
          this._failedEntities.push({
            entityId,
            reason: `Endpoint id collides with ${collision?.[0] ?? parkedBy}. Set distinct custom names.`,
          });
          continue;
        }

        if (isHeapUnderPressure()) {
          this.log.error(
            "Memory pressure detected, cannot create device endpoint. " +
              "Reduce entities on other bridges or increase the Node.js heap size (NODE_OPTIONS=--max-old-space-size=1024).",
          );
          this._failedEntities.push({
            entityId,
            reason:
              "Skipped due to memory pressure, reduce entities or increase heap size",
          });
          continue;
        }

        try {
          const domain = entityId.split(".")[0] as HomeAssistantDomain;

          // Vacuums use ServerModeVacuumDevice (no bridgedDeviceBasicInformation)
          // so they appear standalone, which Apple Siri and Alexa require.
          const endpoint =
            domain === "vacuum"
              ? await this.createServerModeVacuumEndpoint(
                  entityId,
                  mapping,
                  resolved?.endpointId,
                )
              : await LegacyEndpoint.create(
                  this.registry,
                  entityId,
                  mapping,
                  undefined,
                  true,
                  resolved?.endpointId,
                  resolved?.anchorEntityId,
                );

          if (!endpoint) {
            this._failedEntities.push({
              entityId,
              reason: "Failed to create endpoint - unsupported device type",
            });
            continue;
          }

          await this.serverNode.addDevice(endpoint);
          this.endpoints.set(entityId, {
            endpoint,
            fingerprint: this.mappingSync.fingerprintAsBuilt(
              mapping,
              entityId,
              endpoint.mappedEntityIds,
            ),
          });
          // mounted for real, so nothing this entity parked is reserved any
          // more, not even an id it left behind under an older custom name
          for (const [id, owner] of this.parkedEndpointIds) {
            if (id === endpointId || owner === entityId) {
              this.parkedEndpointIds.delete(id);
            }
          }
          structureChanged = true;
          this.log.info(`Server mode: Added device ${entityId}`);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          this.log.error(`Failed to create server mode device ${entityId}:`, e);
          this._failedEntities.push({ entityId, reason });
        }
      }

      // Identity and advertised type follow the primary entity only. Also run
      // when the structure held but the identity itself moved: a device renamed
      // in Home Assistant changes no endpoint, and the root node kept the old
      // name, manufacturer and model until a restart (#467). Server mode has no
      // BridgedDeviceBasicInformation on the child, the identity lives on the
      // root node, so the bridge-mode snapshot refresh does not cover this.
      const primary = orderedIds.find((id) => this.endpoints.has(id));
      if (primary) {
        const primaryMapping = this.getEntityMapping(primary);
        const primaryEndpoint = this.endpoints.get(primary)?.endpoint;
        const identity = JSON.stringify({
          primary,
          device: this.registry.deviceOf(primary),
          friendlyName:
            this.registry.initialState(primary)?.attributes?.friendly_name,
          mapping: primaryMapping,
          deviceType: primaryEndpoint?.type?.deviceType,
        });
        if (structureChanged || identity !== this.lastServerNodeIdentity) {
          // Only remember it once it landed. The server node reports a failed
          // update instead of throwing, so recording it regardless would skip
          // the retry on the next poll.
          const pushed = await this.updateServerNodeIdentity(
            primary,
            primaryMapping,
            primaryEndpoint,
          );
          if (pushed) {
            this.lastServerNodeIdentity = identity;
          }
        }
      }
    } finally {
      // A stop that landed mid-refresh wins: no timer on a stopped bridge.
      if (lifecycle === this.lifecycle) {
        this.scheduleRemovalRecheck();
      }
      this.mappingSync.rebuildCandidates(
        [...this.endpoints].map(
          ([entityId, entry]) =>
            [entityId, entry.fingerprint] as [string, string],
        ),
      );
      // re-subscribe on every path so mapped-entity subscriptions stay fresh
      if (this.observingRequested) {
        this.startObserving();
      }
    }
  }

  async updateStates(states: HomeAssistantStates): Promise<void> {
    // Merge subscription states into registry so EntityStateProvider
    // reads fresh values for mapped entities (battery, humidity, etc.)
    this.registry.mergeExternalStates(states);

    this.mappingSync.maybeRetry(states, null, this.observingRequested, () =>
      this.refreshDevices(),
    );

    for (const [entityId, entry] of this.endpoints) {
      try {
        await entry.endpoint.updateStates(states);
      } catch (e) {
        this.log.warn(
          `State update failed for server mode endpoint ${entityId}:`,
          e,
        );
      }
    }
  }

  private async updateServerNodeIdentity(
    entityId: string,
    mapping: EntityMappingConfig | undefined,
    endpoint: EntityEndpoint | undefined,
  ): Promise<boolean> {
    const device = this.registry.deviceOf(entityId);
    const state = this.registry.initialState(entityId);
    const friendlyName = state?.attributes?.friendly_name as string | undefined;
    let ok = await this.serverNode.updateDeviceIdentity(
      entityId,
      device,
      mapping,
      friendlyName,
    );
    const deviceType = endpoint?.type?.deviceType;
    if (deviceType != null) {
      ok = (await this.serverNode.updateAdvertisedDeviceType(deviceType)) && ok;
    }
    return ok;
  }

  /**
   * Creates a Server Mode Vacuum endpoint without BridgedDeviceBasicInformation.
   * This makes the vacuum appear as a standalone Matter device, which is required
   * for Apple Home Siri voice commands and Alexa discovery.
   */
  private async createServerModeVacuumEndpoint(
    entityId: string,
    mapping?: EntityMappingConfig,
    endpointId?: string,
  ): Promise<EntityEndpoint | undefined> {
    return ServerModeVacuumEndpoint.create(
      this.registry,
      entityId,
      mapping,
      endpointId,
    );
  }
}
