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
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import type { BridgeRegistry } from "./bridge-registry.js";
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
  private _failedEntities: FailedEntity[] = [];
  private readonly endpoints = new Map<string, ManagedEndpoint>();

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
    identityStorage: EntityIdentityStorage,
    private readonly dataProvider: BridgeDataProvider,
    private readonly log: Logger,
  ) {
    super("ServerModeEndpointManager");
    this.identityResolver = new IdentityResolver(
      identityStorage,
      mappingStorage,
    );
  }

  private getEntityMapping(entityId: string): EntityMappingConfig | undefined {
    return this.mappingStorage.getMapping(this.dataProvider.id, entityId);
  }

  private computeMappingFingerprint(
    mapping: EntityMappingConfig | undefined,
  ): string {
    if (!mapping) return "";
    return JSON.stringify(mapping);
  }

  override async dispose(): Promise<void> {
    this.stopObserving();

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
    this.stopObserving();

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
    return [...ids];
  }

  stopObserving(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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

  // Like removeEndpoints but close() keeps the persisted number pre-allocated,
  // so a same-id recreate reuses it. Used on rename and same-id recreates (#404).
  private async closeEndpoint(entityId: string): Promise<void> {
    const entry = this.endpoints.get(entityId);
    if (!entry) return;
    try {
      await entry.endpoint.close();
    } catch (e) {
      this.log.warn(`Failed to close endpoint ${entityId}:`, e);
    }
    this.serverNode.forgetDevice(entry.endpoint);
    this.endpoints.delete(entityId);
  }

  async refreshDevices(): Promise<void> {
    this.registry.refresh();
    this._failedEntities = [];

    this.entityIds = this.registry.entityIds;

    try {
      if (this.entityIds.length === 0) {
        this.log.warn("Server mode bridge has no entities configured");
        await this.removeEndpoints([...this.endpoints.keys()]);
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
      const removed = [...this.endpoints.keys()].filter((id) => !keep.has(id));
      let structureChanged = removed.length > 0;
      const genuinelyRemoved: string[] = [];
      for (const oldId of removed) {
        const entry = this.endpoints.get(oldId);
        const claimant = entry
          ? endpointIdToEntity.get(entry.endpoint.id)
          : undefined;
        if (entry && claimant != null && claimant !== oldId) {
          await this.closeEndpoint(oldId);
        } else {
          genuinelyRemoved.push(oldId);
        }
      }
      await this.removeEndpoints(genuinelyRemoved);

      for (const entityId of orderedIds) {
        const mapping = this.getEntityMapping(entityId);

        if (mapping?.disabled) {
          this.log.warn(
            `Entity in server mode bridge is disabled: ${entityId}`,
          );
          if (this.endpoints.has(entityId)) {
            await this.removeEndpoints([entityId]);
            structureChanged = true;
          }
          this._failedEntities.push({
            entityId,
            reason: "The configured entity is disabled for this bridge.",
          });
          continue;
        }

        const fingerprint = this.computeMappingFingerprint(mapping);
        const existing = this.endpoints.get(entityId);
        if (existing && existing.fingerprint === fingerprint) {
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
        if (collision) {
          this._failedEntities.push({
            entityId,
            reason: `Endpoint id collides with ${collision[0]}. Set distinct custom names.`,
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
          this.endpoints.set(entityId, { endpoint, fingerprint });
          structureChanged = true;
          this.log.info(`Server mode: Added device ${entityId}`);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          this.log.error(`Failed to create server mode device ${entityId}:`, e);
          this._failedEntities.push({ entityId, reason });
        }
      }

      // identity and advertised type follow the primary entity only
      if (structureChanged) {
        const primary = orderedIds.find((id) => this.endpoints.has(id));
        if (primary) {
          await this.updateServerNodeIdentity(
            primary,
            this.getEntityMapping(primary),
            this.endpoints.get(primary)?.endpoint,
          );
        }
      }
    } finally {
      // re-subscribe on every path so mapped-entity subscriptions stay fresh
      if (this.unsubscribe) {
        this.startObserving();
      }
    }
  }

  async updateStates(states: HomeAssistantStates): Promise<void> {
    // Merge subscription states into registry so EntityStateProvider
    // reads fresh values for mapped entities (battery, humidity, etc.)
    this.registry.mergeExternalStates(states);

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
  ): Promise<void> {
    const device = this.registry.deviceOf(entityId);
    const state = this.registry.initialState(entityId);
    const friendlyName = state?.attributes?.friendly_name as string | undefined;
    await this.serverNode.updateDeviceIdentity(
      entityId,
      device,
      mapping,
      friendlyName,
    );
    const deviceType = endpoint?.type?.deviceType;
    if (deviceType != null) {
      await this.serverNode.updateAdvertisedDeviceType(deviceType);
    }
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
