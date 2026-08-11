import type {
  EntityMappingConfig,
  FailedEntity,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import { Endpoint, type MutableEndpoint } from "@matter/main";
import { Service } from "../../core/ioc/service.js";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import {
  createEndpointId,
  type EntityEndpoint,
} from "../../matter/endpoints/entity-endpoint.js";
import { LegacyEndpoint } from "../../matter/endpoints/legacy/legacy-endpoint.js";
import { getVacuumServiceAreas } from "../../matter/endpoints/legacy/vacuum/behaviors/vacuum-service-area-server.js";
import { VacuumAreaSwitchEndpoint } from "../../matter/endpoints/legacy/vacuum/vacuum-area-switch.js";
import { validateEndpointType } from "../../matter/endpoints/validate-endpoint-type.js";
import { BUILTIN_PLUGINS } from "../../plugins/builtin/index.js";
import { createPluginEndpointType } from "../../plugins/plugin-device-factory.js";
import type { PluginInstaller } from "../../plugins/plugin-installer.js";
import type { PluginManager } from "../../plugins/plugin-manager.js";
import type { PluginRegistry } from "../../plugins/plugin-registry.js";
import type {
  PluginConfigSchema,
  PluginDevice,
  PluginMetadata,
} from "../../plugins/types.js";
import { isHeapUnderPressure } from "../../utils/log-memory.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
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
import type { BridgeRegistry } from "./bridge-registry.js";
import { EntityIsolationService } from "./entity-isolation-service.js";
import {
  IdentityResolver,
  identityKey,
  type ResolvedIdentity,
} from "./identity-resolver.js";

const MAX_ENTITY_ID_LENGTH = 150;

// Keep an endpoint this long after its entity leaves the registry, so a
// transient HA restart does not erase its persisted number and drop groups.
const ENDPOINT_REMOVAL_GRACE_MS = 60_000;

// Plugin devices mount as bare Endpoints without any entity fields, keep them
// out of the entity flows (#445). Composed endpoints only duck-type
// EntityEndpoint, so instanceof would wrongly drop them.
function isEntityPart(p: Endpoint): p is EntityEndpoint {
  return typeof (p as Partial<EntityEndpoint>).updateStates === "function";
}

// Reconcile and isolation key on entity IDENTITY, not update capability: a
// future plugin endpoint defining updateStates must still stay out of the
// removal and isolation flows (it has no entity_id to reconcile against).
function hasEntityIdentity(p: Endpoint): p is EntityEndpoint {
  return typeof (p as Partial<EntityEndpoint>).entityId === "string";
}

// matter.js Observable is dynamically typed per endpoint.
// biome-ignore lint/suspicious/noExplicitAny: matter.js Observable has no static type
type PluginObservable = any;
interface PluginListenerRef {
  observable: PluginObservable;
  listener: (value: unknown) => void;
}

export class BridgeEndpointManager extends Service {
  readonly root: Endpoint;
  private entityIds: string[] = [];
  private unsubscribe?: () => void;
  private _failedEntities: FailedEntity[] = [];
  private readonly mappingFingerprints = new Map<string, string>();
  // entityId -> first time it went missing from the registry (grace window)
  private readonly pendingRemovals = new Map<string, number>();
  private removalRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pluginEndpoints = new Map<string, Endpoint>();
  private readonly pluginStateUpdating = new Set<string>();
  private readonly pluginListeners = new Map<string, PluginListenerRef[]>();

  get failedEntities(): FailedEntity[] {
    // Combine static failed entities with dynamically isolated entities
    const isolated = EntityIsolationService.getIsolatedEntities(this.bridgeId);
    return [...this._failedEntities, ...isolated];
  }

  private addFailedEntity(entityId: string, reason: string) {
    this._failedEntities.push({
      entityId,
      reason,
      failedAt: new Date().toISOString(),
    });
  }

  private readonly identityResolver: IdentityResolver;

  constructor(
    private readonly client: HomeAssistantClient,
    private readonly registry: BridgeRegistry,
    private readonly mappingStorage: EntityMappingStorage,
    private readonly identityStorage: EntityIdentityStorage,
    private readonly bridgeId: string,
    private readonly log: Logger,
    private readonly pluginManager?: PluginManager,
    private readonly pluginRegistry?: PluginRegistry,
    private readonly pluginInstaller?: PluginInstaller,
  ) {
    super("BridgeEndpointManager");
    this.root = new AggregatorEndpoint("aggregator");
    this.identityResolver = new IdentityResolver(
      identityStorage,
      mappingStorage,
    );

    // Register callback to isolate problematic entities at runtime
    EntityIsolationService.registerIsolationCallback(
      bridgeId,
      this.isolateEntity.bind(this),
    );

    if (this.pluginManager) {
      this.wirePluginCallbacks();
    }
  }

  private wirePluginCallbacks(): void {
    if (!this.pluginManager) return;

    this.pluginManager.onDeviceRegistered = async (
      pluginName: string,
      device: PluginDevice,
    ) => {
      // Two paths: a plugin-supplied custom EndpointType (own clusters/command
      // handlers), or a built-in device type from the fixed factory map.
      let endpoint: Endpoint;
      if (device.endpointType) {
        try {
          validateEndpointType(
            device.endpointType,
            `plugin:${pluginName}:${device.id}`,
          );
        } catch (e) {
          this.log.warn(
            `Plugin "${pluginName}": invalid endpointType for device "${device.id}":`,
            e,
          );
          return;
        }
        const initialState: Record<string, object> = {};
        for (const cluster of device.clusters) {
          initialState[cluster.clusterId] = cluster.attributes;
        }
        // The plugin owns its behaviors, so no PluginDeviceBehavior here.
        const base = device.endpointType as MutableEndpoint;
        endpoint = new Endpoint(
          Object.keys(initialState).length > 0 ? base.set(initialState) : base,
          { id: `plugin_${device.id}` },
        );
      } else {
        const type = createPluginEndpointType(device.deviceType ?? "");
        if (!type) {
          this.log.warn(
            `Plugin "${pluginName}": unsupported device type "${device.deviceType}" for device "${device.id}"`,
          );
          return;
        }
        // Set PluginDeviceBehavior state and apply initial cluster config
        const initialState: Record<string, object> = {
          pluginDevice: { device, pluginName },
        };
        for (const cluster of device.clusters) {
          initialState[cluster.clusterId] = cluster.attributes;
        }
        endpoint = new Endpoint(type.set(initialState), {
          id: `plugin_${device.id}`,
        });
      }
      try {
        await this.root.add(endpoint);
        this.pluginEndpoints.set(device.id, endpoint);
        this.wirePluginEndpointEvents(device, endpoint);
        this.log.info(
          `Plugin "${pluginName}": added device "${device.name}" (${device.deviceType})`,
        );
      } catch (e) {
        this.log.warn(
          `Plugin "${pluginName}": failed to add device "${device.id}":`,
          e,
        );
      }
    };

    this.pluginManager.onDeviceUnregistered = async (
      pluginName: string,
      deviceId: string,
      options?: { keepIdentity?: boolean },
    ) => {
      const listeners = this.pluginListeners.get(deviceId);
      if (listeners) {
        for (const { observable, listener } of listeners) {
          try {
            observable.off(listener);
          } catch {
            // Observable may already be disposed, ignore.
          }
        }
        this.pluginListeners.delete(deviceId);
      }
      const endpoint = this.pluginEndpoints.get(deviceId);
      if (endpoint) {
        try {
          if (options?.keepIdentity) {
            // A reversible stop: close keeps the persisted endpoint number,
            // so a re-enable mounts under the same identity. delete would
            // free the number and renumber every device on the next enable.
            await endpoint.close();
          } else {
            await endpoint.delete();
          }
        } catch (e) {
          this.log.warn(
            `Plugin "${pluginName}": failed to remove device "${deviceId}":`,
            e,
          );
        }
        this.pluginEndpoints.delete(deviceId);
      }
    };

    this.pluginManager.onDeviceStateUpdated = (
      pluginName: string,
      deviceId: string,
      clusterId: string,
      attributes: Record<string, unknown>,
    ) => {
      const endpoint = this.pluginEndpoints.get(deviceId);
      if (!endpoint) return;
      const behaviorType = endpoint.type.behaviors[clusterId];
      if (!behaviorType) {
        this.log.debug(
          `Plugin "${pluginName}": cluster "${clusterId}" not found on device "${deviceId}"`,
        );
        return;
      }
      this.pluginStateUpdating.add(deviceId);
      endpoint
        .setStateOf(behaviorType, attributes)
        .catch((e) => {
          this.log.warn(
            `Plugin "${pluginName}": failed to update "${clusterId}" on "${deviceId}":`,
            e,
          );
        })
        .finally(() => {
          this.pluginStateUpdating.delete(deviceId);
        });
    };
  }

  private wirePluginEndpointEvents(
    device: PluginDevice,
    endpoint: Endpoint,
  ): void {
    if (!device.onAttributeWrite) return;
    // biome-ignore lint/suspicious/noExplicitAny: matter.js events are dynamically typed per endpoint
    const allEvents = endpoint.events as any;
    const listeners: PluginListenerRef[] = [];
    for (const behaviorId of Object.keys(endpoint.type.behaviors)) {
      if (behaviorId === "pluginDevice") continue;
      const behaviorEvents = allEvents[behaviorId];
      if (!behaviorEvents || typeof behaviorEvents !== "object") continue;
      // The $Changed emitters are non-enumerable getters spread over the
      // events prototype chain, Object.keys sees none of them.
      const eventNames = new Set<string>();
      for (
        let proto = behaviorEvents;
        proto && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto)
      ) {
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name.endsWith("$Changed")) eventNames.add(name);
        }
      }
      for (const eventName of eventNames) {
        const observable = behaviorEvents[eventName];
        if (!observable || typeof observable.on !== "function") continue;
        const attrName = eventName.slice(0, -"$Changed".length);
        const listener = (newValue: unknown) => {
          if (this.pluginStateUpdating.has(device.id)) return;
          device
            .onAttributeWrite?.(behaviorId, attrName, newValue)
            .catch((e: unknown) => {
              this.log.debug(
                `Plugin device "${device.id}": onAttributeWrite error for ${behaviorId}.${attrName}:`,
                e,
              );
            });
        };
        observable.on(listener);
        listeners.push({ observable, listener });
      }
    }
    if (listeners.length > 0) {
      this.pluginListeners.set(device.id, listeners);
    }
  }

  async startPlugins(): Promise<void> {
    if (!this.pluginManager) return;
    await this.registerBuiltInPlugins();
    await this.loadRegisteredPlugins();
    await this.pluginManager.startAll();
    await this.pluginManager.configureAll();
  }

  // Built-in plugins ship inside the backend bundle, so they share the same
  // matter.js instance and can hand over live EndpointTypes.
  private async registerBuiltInPlugins(): Promise<void> {
    if (!this.pluginManager) return;
    for (const Plugin of BUILTIN_PLUGINS) {
      const plugin = new Plugin();
      try {
        await this.pluginManager.registerBuiltIn(plugin);
      } catch (e) {
        this.log.warn(
          `Failed to register built-in plugin "${plugin.name}":`,
          e,
        );
      }
    }
  }

  private async loadRegisteredPlugins(): Promise<void> {
    if (!this.pluginManager || !this.pluginRegistry || !this.pluginInstaller)
      return;
    const registered = this.pluginRegistry.getAll();
    for (const entry of registered) {
      if (!entry.autoLoad) continue;
      const packagePath = this.pluginInstaller.getPluginPath(entry.packageName);
      try {
        await this.pluginManager.loadExternal(packagePath, entry.config);
        this.log.info(
          `Loaded external plugin: ${entry.packageName} from ${packagePath}`,
        );
      } catch (e) {
        this.log.warn(
          `Failed to load external plugin "${entry.packageName}":`,
          e,
        );
      }
    }
  }

  async stopPlugins(): Promise<void> {
    if (!this.pluginManager) return;
    await this.pluginManager.shutdownAll("Bridge stopping");
    for (const [id, endpoint] of this.pluginEndpoints) {
      try {
        await endpoint.delete();
      } catch (e) {
        this.log.warn(`Failed to delete plugin endpoint ${id}:`, e);
      }
    }
    this.pluginEndpoints.clear();
  }

  getPluginInfo(): {
    metadata: PluginMetadata[];
    devices: Array<{ pluginName: string; device: PluginDevice }>;
    circuitBreakers: Record<
      string,
      {
        failures: number;
        disabled: boolean;
        lastError?: string;
        disabledAt?: number;
      }
    >;
  } {
    if (!this.pluginManager) {
      return { metadata: [], devices: [], circuitBreakers: {} };
    }
    const cbStates = this.pluginManager.getCircuitBreakerStates();
    const circuitBreakers: Record<
      string,
      {
        failures: number;
        disabled: boolean;
        lastError?: string;
        disabledAt?: number;
      }
    > = {};
    for (const [name, state] of cbStates) {
      circuitBreakers[name] = state;
    }
    return {
      metadata: this.pluginManager.getMetadata(),
      devices: this.pluginManager.getAllDevices(),
      circuitBreakers,
    };
  }

  async enablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.pluginManager?.enablePlugin(pluginName);
  }

  async disablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.pluginManager?.disablePlugin(pluginName);
  }

  resetPlugin(pluginName: string): void {
    this.pluginManager?.resetPlugin(pluginName);
  }

  getPluginConfigSchema(pluginName: string): PluginConfigSchema | undefined {
    return this.pluginManager?.getConfigSchema(pluginName);
  }

  async updatePluginConfig(
    pluginName: string,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    return (
      (await this.pluginManager?.updateConfig(pluginName, config)) ?? false
    );
  }

  /**
   * Isolate an entity by removing it from the aggregator.
   * Called by EntityIsolationService when a runtime error is detected.
   */
  async isolateEntity(entityName: string): Promise<void> {
    const endpoints = [...this.root.parts].filter(hasEntityIdentity);
    // The room switches share the vacuum's entity_id, so an entity_id match
    // must land on the vacuum. A switch is only isolated via its own part id.
    const endpoint =
      endpoints.find(
        (e) =>
          !(e instanceof VacuumAreaSwitchEndpoint) &&
          (e.id === entityName || e.entityId === entityName),
      ) ?? endpoints.find((e) => e.id === entityName);

    if (endpoint) {
      this.log.warn(
        `Isolating entity ${endpoint.entityId} due to runtime error`,
      );
      try {
        await endpoint.delete();
      } catch (e) {
        this.log.error(`Failed to delete isolated endpoint:`, e);
      }
      this.pendingRemovals.delete(endpoint.entityId);
      this.mappingFingerprints.delete(endpoint.entityId);
      if (!(endpoint instanceof VacuumAreaSwitchEndpoint)) {
        // An isolated vacuum takes its room switches along.
        for (const sw of endpoints) {
          if (!(sw instanceof VacuumAreaSwitchEndpoint)) continue;
          if (sw.vacuumEndpointId !== endpoint.id) continue;
          try {
            await sw.delete();
          } catch (e) {
            this.log.warn(`Failed to remove area switch ${sw.id}:`, e);
          }
        }
      }
    }
  }

  // refreshDevices only runs on registry-fingerprint changes, which may not
  // recur, so drive any held removals to completion ourselves once the grace
  // window has passed.
  private scheduleRemovalRecheck() {
    if (this.removalRecheckTimer) {
      clearTimeout(this.removalRecheckTimer);
      this.removalRecheckTimer = null;
    }
    if (this.pendingRemovals.size === 0) return;
    this.removalRecheckTimer = setTimeout(() => {
      this.removalRecheckTimer = null;
      this.refreshDevices().catch((e) =>
        this.log.warn("Endpoint removal recheck failed:", e),
      );
    }, ENDPOINT_REMOVAL_GRACE_MS + 5_000);
  }

  private getPluginDomainMappings(): Map<string, string> | undefined {
    if (!this.pluginManager) return undefined;
    const mappings = this.pluginManager.getDomainMappings();
    if (mappings.size === 0) return undefined;
    const result = new Map<string, string>();
    for (const [domain, mapping] of mappings) {
      result.set(domain, mapping.matterDeviceType);
    }
    return result;
  }

  private getEntityMapping(entityId: string): EntityMappingConfig | undefined {
    return this.mappingStorage.getMapping(this.bridgeId, entityId);
  }

  private computeMappingFingerprint(
    mapping: EntityMappingConfig | undefined,
  ): string {
    if (!mapping) return "";
    return JSON.stringify(mapping);
  }

  override async dispose(): Promise<void> {
    this.stopObserving();
    if (this.removalRecheckTimer) {
      clearTimeout(this.removalRecheckTimer);
      this.removalRecheckTimer = null;
    }
    this.pendingRemovals.clear();
    EntityIsolationService.unregisterIsolationCallback(this.bridgeId);
    EntityIsolationService.clearIsolatedEntities(this.bridgeId);

    // Close all endpoints to free memory while preserving stored endpoint
    // numbers. Using delete() here would erase the persisted endpoint numbers
    // from matter.js storage, causing controllers to treat devices as new on
    // the next restart (losing names, rooms, icons, and automations).
    const endpoints = this.root.parts.map((p) => p as EntityEndpoint);
    for (const endpoint of endpoints) {
      try {
        await endpoint.close();
      } catch (e) {
        this.log.warn(`Failed to close endpoint during dispose:`, e);
      }
    }
  }

  async startObserving() {
    this.stopObserving();

    if (!this.entityIds.length) {
      return;
    }

    const subscriptionIds = this.collectSubscriptionEntityIds();
    this.unsubscribe = subscribeEntities(
      this.client.connection,
      (e, changed) => this.updateStates(e, changed),
      subscriptionIds,
    );
  }

  private collectSubscriptionEntityIds(): string[] {
    const ids = new Set(this.entityIds);
    const endpoints = this.root.parts.map((p) => p as EntityEndpoint);
    for (const endpoint of endpoints) {
      const mappedIds = endpoint.mappedEntityIds;
      if (mappedIds) {
        for (const mappedId of mappedIds) {
          ids.add(mappedId);
        }
      }
    }
    return [...ids];
  }

  stopObserving() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async refreshDevices() {
    this.registry.refresh();
    this._failedEntities = [];

    // Area switches (#355) share the vacuum's entity_id but ride their own
    // reconcile pass keyed off the surviving vacuum endpoint, so they must never
    // enter the entity reconcile below (it would collide on entity_id).
    const endpoints = [...this.root.parts]
      .filter(hasEntityIdentity)
      .filter((p) => !(p instanceof VacuumAreaSwitchEndpoint));
    this.entityIds = this.registry.entityIds;

    // Pre-calculate composed sub-entities so they get skipped
    // during individual endpoint creation (requires mapping access).
    if (this.registry.isAutoComposedDevicesEnabled()) {
      for (const eid of this.entityIds) {
        const m = this.getEntityMapping(eid);

        // User-defined composed entities (#220)
        if (m?.composedEntities) {
          for (const sub of m.composedEntities) {
            if (sub.entityId) {
              this.registry.markComposedSubEntityUsed(sub.entityId);
            }
          }
        }

        // Auto-composed air purifier sub-entities
        if (!eid.startsWith("fan.")) continue;
        const matterType = m?.matterDeviceType ?? "fan";
        if (matterType !== "air_purifier") continue;
        const ent = this.registry.entity(eid);
        // Manual mapping takes priority over auto-discovery
        const tempId =
          m?.temperatureEntity ||
          (ent?.device_id
            ? this.registry.findTemperatureEntityForDevice(ent.device_id)
            : undefined);
        const humId =
          m?.humidityEntity ||
          (ent?.device_id
            ? this.registry.findHumidityEntityForDevice(ent.device_id)
            : undefined);
        if (tempId) this.registry.markComposedSubEntityUsed(tempId);
        if (humId) this.registry.markComposedSubEntityUsed(humId);
      }
    }

    // Phase 0: resolve stable identities for every current entity before any
    // add or remove. A rename (entity_id changed, identity key unchanged) then
    // maps to the same endpoint id, so the endpoint is rebuilt under its
    // preserved number instead of being torn down and re-added (#404).
    const stableIdentity = this.registry.isStableIdentityEnabled();
    const resolvedByEntity = new Map<string, ResolvedIdentity>();
    const endpointIdToEntity = new Map<string, string>();
    const claimedEndpointIds = new Map<string, string>();
    for (const entityId of this.entityIds) {
      const entityInfo = {
        entity_id: entityId,
        registry: this.registry.entity(entityId),
      };
      const resolved = await this.identityResolver.resolveIdentity(
        this.bridgeId,
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
      // Carry the in-memory fingerprint to the new entity id so the create loop
      // does not read a spurious mapping change after a rename re-key.
      if (
        resolved.renamedFrom &&
        this.mappingFingerprints.has(resolved.renamedFrom)
      ) {
        const fp = this.mappingFingerprints.get(resolved.renamedFrom)!;
        this.mappingFingerprints.delete(resolved.renamedFrom);
        this.mappingFingerprints.set(entityId, fp);
      }
    }

    // Reconcile orphan tombstones against the FULL HA registry (keyed by the
    // rename-stable identity key, so a rename, a filter change, or a scope
    // narrowing never reads as a removal). Stamp/clear only, never delete.
    const fullEntities = this.registry.fullEntities;
    stampIdentityPresence(
      this.identityStorage,
      this.bridgeId,
      buildPresentIdentityKeys(fullEntities),
    );
    // Same reconcile for stray custom mappings, keyed by entity_id: it catches a
    // flag-off rename that left the mapping at the old id and keyless entities
    // that have no identity record.
    stampMappingPresence(
      this.mappingStorage,
      this.bridgeId,
      buildPresentEntityIds(fullEntities),
    );

    // A current entity can claim a switch's derived id; the entity wins, so
    // drop the switch before the create loop trips over the taken id (#355).
    for (const part of [...this.root.parts]) {
      if (!(part instanceof VacuumAreaSwitchEndpoint)) continue;
      const claimant = endpointIdToEntity.get(part.id);
      if (claimant == null) continue;
      this.log.info(
        `Area switch ${part.id} collides with entity ${claimant}, removing the switch`,
      );
      try {
        await part.delete();
      } catch (e) {
        this.log.warn(`Failed to remove colliding area switch ${part.id}:`, e);
      }
    }

    // Zero entities in the whole HA registry means HA is down or still
    // starting, not that every device was removed. Deleting now erases the
    // Matter numbers and controllers re-add everything, losing groups (#438).
    // Reset the grace so removals start fresh once HA is back.
    if (
      Object.keys(this.registry.fullEntities).length === 0 &&
      endpoints.length > 0
    ) {
      this.pendingRemovals.clear();
      this.log.warn(
        `HA registry has no entities, skipping removal of ${endpoints.length} endpoints (HA down?)`,
      );
      return;
    }

    const existingEndpoints: EntityEndpoint[] = [];
    const now = Date.now();
    for (const endpoint of endpoints) {
      const present = this.entityIds.includes(endpoint.entityId);

      // Rename: a different current entity now owns this endpoint's id while
      // this endpoint's own entity is gone. close() keeps the persisted number
      // pre-allocated so the create loop rebuilds it under the same id with the
      // renamed entity. Never delete() here, that would erase the number (#404).
      const claimant = endpointIdToEntity.get(endpoint.id);
      if (!present && claimant != null && claimant !== endpoint.entityId) {
        this.log.info(
          `Entity renamed ${endpoint.entityId} -> ${claimant}, keeping endpoint ${endpoint.id}`,
        );
        try {
          await endpoint.close();
        } catch (e) {
          this.log.warn(
            `Failed to close renamed endpoint ${endpoint.entityId}:`,
            e,
          );
        }
        this.pendingRemovals.delete(endpoint.entityId);
        this.mappingFingerprints.delete(endpoint.entityId);
        continue;
      }

      if (present) {
        this.pendingRemovals.delete(endpoint.entityId);
      }
      if (!present) {
        // An entity can vanish from the registry briefly during an HA restart.
        // delete() erases the persisted endpoint number, so controllers (Alexa)
        // treat the recreated device as new and lose groups. Wait out a grace
        // window before removing it for good.
        const since = this.pendingRemovals.get(endpoint.entityId);
        if (since == null) {
          this.pendingRemovals.set(endpoint.entityId, now);
          existingEndpoints.push(endpoint);
          continue;
        }
        if (now - since < ENDPOINT_REMOVAL_GRACE_MS) {
          existingEndpoints.push(endpoint);
          continue;
        }
        try {
          // The only number-erasing path with no trace: say it out loud, a
          // controller holding the old number sees a dead endpoint (#423).
          this.log.info(
            `Removing endpoint ${endpoint.entityId} (ep ${endpoint.number}) after the grace window, controllers will see a new number if it returns`,
          );
          await endpoint.delete();
        } catch (e) {
          this.log.warn(`Failed to delete endpoint ${endpoint.entityId}:`, e);
        }
        this.mappingFingerprints.delete(endpoint.entityId);
        this.pendingRemovals.delete(endpoint.entityId);
      } else if (
        this.registry.isAutoComposedDevicesEnabled() &&
        this.registry.isComposedSubEntityUsed(endpoint.entityId)
      ) {
        // Entity was consumed by a composed device (e.g., temp/hum sensor
        // absorbed into an air purifier). Delete the standalone endpoint so
        // the composed device is the only representation (#218).
        this.log.info(
          `Deleting standalone endpoint ${endpoint.entityId}, consumed by composed device`,
        );
        try {
          await endpoint.delete();
        } catch (e) {
          this.log.warn(
            `Failed to delete composed sub-entity endpoint ${endpoint.entityId}:`,
            e,
          );
        }
        this.mappingFingerprints.delete(endpoint.entityId);
      } else {
        // Check if the mapping changed since the endpoint was created.
        // If so, delete the old endpoint so it gets recreated with the new config.
        const currentMapping = this.getEntityMapping(endpoint.entityId);
        const currentFp = this.computeMappingFingerprint(currentMapping);
        const storedFp = this.mappingFingerprints.get(endpoint.entityId) ?? "";
        if (currentFp !== storedFp) {
          this.log.info(
            `Mapping changed for ${endpoint.entityId}, recreating endpoint`,
          );
          // #404: if the recreate keeps the same endpoint id, close() (not
          // delete()) so matter.js keeps the persisted number and Alexa keeps
          // the device with its groups. delete() would erase it and the recreate
          // would get a fresh number. When the id itself changes (customName
          // edit on an unprotected entity) the number can't be kept anyway, so
          // delete() to free it. For a protected entity the resolved id is
          // frozen, so a customName change stays on the close() branch.
          const resolvedId =
            resolvedByEntity.get(endpoint.entityId)?.endpointId ??
            createEndpointId(endpoint.entityId, currentMapping?.customName);
          const sameId = resolvedId === endpoint.id;
          try {
            if (sameId) {
              await endpoint.close();
            } else {
              await endpoint.delete();
            }
          } catch (e) {
            this.log.warn(
              `Failed to recreate endpoint ${endpoint.entityId} for mapping change:`,
              e,
            );
          }
          this.mappingFingerprints.delete(endpoint.entityId);
        } else {
          existingEndpoints.push(endpoint);
        }
      }
    }

    this.scheduleRemovalRecheck();

    let memoryLimitReached = false;

    for (const entityId of this.entityIds) {
      // Check heap pressure before creating a new endpoint.
      // matter.js endpoints are memory-heavy (~1-3 MB each), so we stop
      // loading more entities when the heap approaches its limit to
      // prevent OOM crashes. Already-loaded endpoints keep working.
      if (!memoryLimitReached && isHeapUnderPressure()) {
        memoryLimitReached = true;
        this.log.error(
          "Memory pressure detected, skipping remaining entities to prevent OOM crash. " +
            "Reduce the number of entities in this bridge or increase the Node.js heap size (NODE_OPTIONS=--max-old-space-size=1024).",
        );
      }
      if (memoryLimitReached) {
        // Skip existing endpoints that are already loaded
        if (!existingEndpoints.some((e) => e.entityId === entityId)) {
          this.addFailedEntity(
            entityId,
            "Skipped due to memory pressure, reduce entities or increase heap size",
          );
        }
        continue;
      }

      const mapping = this.getEntityMapping(entityId);

      if (mapping?.disabled) {
        this.log.debug(`Skipping disabled entity: ${entityId}`);
        continue;
      }

      if (
        this.registry.isAutoComposedDevicesEnabled() &&
        this.registry.isComposedSubEntityUsed(entityId)
      ) {
        this.log.debug(
          `Skipping ${entityId}, already part of a composed device`,
        );
        continue;
      }

      if (entityId.length > MAX_ENTITY_ID_LENGTH) {
        const reason = `Entity ID too long (${entityId.length} chars, max ${MAX_ENTITY_ID_LENGTH}). This would cause filesystem errors.`;
        this.log.warn(`Skipping entity: ${entityId}. Reason: ${reason}`);
        this.addFailedEntity(entityId, reason);
        continue;
      }

      let endpoint = existingEndpoints.find((e) => e.entityId === entityId);
      if (!endpoint) {
        try {
          const domainMappings = this.getPluginDomainMappings();
          const resolved = resolvedByEntity.get(entityId);
          endpoint = await LegacyEndpoint.create(
            this.registry,
            entityId,
            mapping,
            domainMappings,
            false,
            resolved?.endpointId,
            resolved?.anchorEntityId,
          );
        } catch (e) {
          // Handle all endpoint creation errors gracefully to prevent boot crashes
          const reason = this.extractErrorReason(e);
          this.log.warn(`Failed to create device ${entityId}: ${reason}`);
          this.addFailedEntity(entityId, reason);
          continue;
        }

        if (endpoint) {
          try {
            await this.root.add(endpoint);
            this.mappingFingerprints.set(
              entityId,
              this.computeMappingFingerprint(mapping),
            );
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            // Handle all endpoint initialization errors gracefully
            this.log.warn(
              `Failed to add endpoint for ${entityId}: ${errorMessage}`,
            );
            // Extract detailed behavior error info for debugging
            this.logDetailedError(entityId, e);
            this.addFailedEntity(entityId, this.extractErrorReason(e));
          }
        }
      }
    }

    await this.reconcileAreaSwitches();

    if (this.unsubscribe) {
      this.startObserving();
    }
  }

  // Opt-in per-area room switches (#355). One momentary OnOffPlugInUnit sibling
  // per configured service area, mounted alongside its vacuum with a stable
  // derived id. Areas and mapping come from the parent's vacuumEffective, the
  // exact config its ServiceArea cluster was built from, never from raw storage
  // (raw can be a different id space: injected Valetudo/Roborock rooms,
  // auto-resolved CLEAN_AREA). The vacuum's own endpoint is never touched here.
  // Switches are kept while their parent endpoint survives with the flag on
  // (the parent's removal grace is mirrored for free), rebuilt via close() when
  // the parent was recreated for a mapping change so numbers survive, and
  // deleted when the flag goes off, the area is gone, or the parent is gone.
  private async reconcileAreaSwitches(): Promise<void> {
    const parts = this.root.parts.map((p) => p as EntityEndpoint);
    const switches = parts.filter(
      (p): p is VacuumAreaSwitchEndpoint =>
        p instanceof VacuumAreaSwitchEndpoint,
    );
    const vacuumById = new Map<string, EntityEndpoint>();
    for (const part of parts) {
      if (part instanceof VacuumAreaSwitchEndpoint) continue;
      vacuumById.set(part.id, part);
    }

    // Isolated records key on the part id the error path named, or on the
    // entity id. A vacuum in there must not carry switches (#355).
    const isolated = new Set(
      EntityIsolationService.getIsolatedEntities(this.bridgeId).map(
        (f) => f.entityId,
      ),
    );
    const parentIsolated = (parent: EntityEndpoint) =>
      isolated.has(parent.id) ||
      (parent.entityId != null && isolated.has(parent.entityId));

    const kept = new Set<string>();
    for (const sw of switches) {
      const parent = vacuumById.get(sw.vacuumEndpointId);
      const mapping = parent
        ? this.getEntityMapping(parent.entityId)
        : undefined;
      const effective =
        parent instanceof LegacyEndpoint ? parent.vacuumEffective : undefined;
      let keep = false;
      let rebuild = false;
      if (
        parent &&
        !parentIsolated(parent) &&
        mapping?.vacuumRoomSwitches &&
        effective
      ) {
        const areas = getVacuumServiceAreas(
          effective.state.attributes as VacuumDeviceAttributes,
          effective.mapping,
        );
        if (areas.some((a) => a.areaId === sw.areaId)) {
          if (sw.parentEffective === effective) {
            keep = true;
          } else {
            // Parent was recreated, its effective config is a fresh object.
            rebuild = true;
          }
        }
      }
      if (keep) {
        kept.add(sw.id);
        continue;
      }
      try {
        if (rebuild) {
          // close keeps the persisted number for the recreate below
          await sw.close();
        } else {
          await sw.delete();
        }
      } catch (e) {
        this.log.warn(`Failed to remove area switch ${sw.id}:`, e);
      }
    }

    // Add missing switches for every present vacuum that opted in.
    for (const part of vacuumById.values()) {
      const entityId = part.entityId;
      if (!entityId?.startsWith("vacuum.")) continue;
      if (parentIsolated(part)) continue;
      const mapping = this.getEntityMapping(entityId);
      if (!mapping?.vacuumRoomSwitches) continue;
      const effective =
        part instanceof LegacyEndpoint ? part.vacuumEffective : undefined;
      if (!effective) continue;
      const areas = getVacuumServiceAreas(
        effective.state.attributes as VacuumDeviceAttributes,
        effective.mapping,
      );
      const entity = {
        entity_id: entityId,
        state: effective.state,
        registry: this.registry.entity(entityId),
        deviceRegistry: this.registry.deviceOf(entityId),
      };
      for (const area of areas) {
        const switchId = `${part.id}_roomsw_${area.areaId}`;
        if (kept.has(switchId)) continue;
        const holder = vacuumById.get(switchId);
        if (holder) {
          this.log.warn(
            `Skipping area switch ${switchId} for ${entityId}: id taken by entity ${holder.entityId}`,
          );
          continue;
        }
        try {
          const endpoint = VacuumAreaSwitchEndpoint.create({
            vacuumEndpointId: part.id,
            entity,
            mapping: effective.mapping,
            area,
            parentEffective: effective,
          });
          await this.root.add(endpoint);
        } catch (e) {
          this.log.warn(
            `Failed to add area switch ${switchId} for ${entityId}:`,
            e,
          );
        }
      }
    }
  }

  private updateInFlight: Promise<void> | undefined;
  private pendingStates: HomeAssistantStates | undefined;
  private pendingChanged: ReadonlySet<string> | null | undefined;

  private mergeChanged(
    a: ReadonlySet<string> | null,
    b: ReadonlySet<string> | null,
  ): ReadonlySet<string> | null {
    if (a === null || b === null) return null;
    const merged = new Set(a);
    for (const id of b) merged.add(id);
    return merged;
  }

  async updateStates(
    states: HomeAssistantStates,
    changed: ReadonlySet<string> | null = null,
  ): Promise<void> {
    // Collapse bursts (HA restart, scene activation) by serializing runs.
    // If a run is already active, stash the latest batch; once the current
    // run finishes it picks up the freshest stash. Older pending batches
    // are dropped, but their changed sets are unioned in so no entity that
    // changed in a dropped batch gets skipped.
    if (this.updateInFlight) {
      this.pendingStates = states;
      this.pendingChanged =
        this.pendingChanged === undefined
          ? changed
          : this.mergeChanged(this.pendingChanged, changed);
      return this.updateInFlight;
    }
    this.updateInFlight = this.runUpdateStates(states, changed).finally(() => {
      this.updateInFlight = undefined;
      const queued = this.pendingStates;
      const queuedChanged = this.pendingChanged;
      this.pendingStates = undefined;
      this.pendingChanged = undefined;
      if (queued) {
        this.updateStates(
          queued,
          queuedChanged === undefined ? null : queuedChanged,
        ).catch((e) => this.log.warn("Queued state update failed:", e));
      }
    });
    return this.updateInFlight;
  }

  private async runUpdateStates(
    states: HomeAssistantStates,
    changed: ReadonlySet<string> | null,
  ): Promise<void> {
    const startMs = performance.now();

    // Merge subscription states into registry so EntityStateProvider
    // reads fresh values for mapped entities (battery, humidity, etc.)
    this.registry.mergeExternalStates(states);

    const allEndpoints = [...this.root.parts].filter(isEntityPart);
    // One HA event arrives as the full state map. Hand it only to endpoints
    // whose own entity or a mapped sub-entity actually changed, so a single
    // entity update no longer fans out to every endpoint.
    const endpoints =
      changed === null
        ? allEndpoints
        : allEndpoints.filter(
            (e) =>
              changed.has(e.entityId) ||
              (e.mappedEntityIds ?? []).some((id) => changed.has(id)),
          );
    if (endpoints.length === 0) return;
    // Process state updates in parallel for faster response times
    // Use allSettled so one failing endpoint doesn't block all others
    const results = await Promise.allSettled(
      endpoints.map((endpoint) => endpoint.updateStates(states)),
    );
    let failedCount = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedCount++;
        this.log.warn("State update failed for endpoint:", result.reason);
      }
    }

    const latencyMs = Math.round((performance.now() - startMs) * 100) / 100;
    if (latencyMs > 200 || failedCount > 0) {
      const msg =
        `State update: ${endpoints.length} endpoints in ${latencyMs}ms` +
        (failedCount > 0 ? ` (${failedCount} failed)` : "");
      if (latencyMs > 200) {
        this.log.warn(`Slow ${msg}`);
      }
      diagnosticEventBus.emit("state_update", msg, {
        bridgeId: this.bridgeId,
        details: {
          endpointCount: endpoints.length,
          failedCount,
          latencyMs,
        },
      });
    }
  }

  /**
   * Log detailed behavior error information for debugging "Behaviors have errors".
   * Matter.js EndpointBehaviorsError extends AggregateError, the `errors` array
   * contains individual behavior crash errors (one per failed behavior).
   */
  private logDetailedError(entityId: string, error: unknown): void {
    if (!(error instanceof Error)) return;

    // Matter.js EndpointBehaviorsError extends AggregateError
    // The `errors` array contains the actual per-behavior errors
    const errorsArray = (error as Error & { errors?: unknown[] }).errors;
    if (Array.isArray(errorsArray) && errorsArray.length > 0) {
      for (let i = 0; i < errorsArray.length; i++) {
        const subError = errorsArray[i];
        const subMsg =
          subError instanceof Error ? subError.message : String(subError);
        this.log.warn(
          `[${entityId}] Behavior error [${i + 1}/${errorsArray.length}]: ${subMsg}`,
        );

        // Walk the cause chain for each sub-error
        let cause: unknown =
          subError instanceof Error
            ? (subError as Error & { cause?: unknown }).cause
            : undefined;
        while (cause instanceof Error) {
          this.log.warn(`[${entityId}]   Caused by: ${cause.message}`);
          cause = (cause as Error & { cause?: unknown }).cause;
        }

        // Log sub-error stack at debug level
        if (subError instanceof Error && subError.stack) {
          this.log.debug(`[${entityId}] Sub-error stack: ${subError.stack}`);
        }
      }
    } else {
      // Fallback: walk the cause chain of the main error
      let current: unknown = (error as Error & { cause?: unknown }).cause;
      while (current instanceof Error) {
        this.log.warn(`[${entityId}] Caused by: ${current.message}`);
        current = (current as Error & { cause?: unknown }).cause;
      }
    }

    // Always log the main error stack at debug level
    if (error.stack) {
      this.log.debug(`[${entityId}] Full stack: ${error.stack}`);
    }
  }

  private extractErrorReason(error: unknown): string {
    if (error instanceof Error) {
      // Check for nested cause (common in Matter.js errors)
      const cause = (error as Error & { cause?: Error }).cause;
      if (cause?.message) {
        return `${error.message}: ${cause.message}`;
      }
      return error.message;
    }
    return String(error);
  }
}
