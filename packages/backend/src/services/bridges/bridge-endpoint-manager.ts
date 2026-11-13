import { createHash } from "node:crypto";
import {
  classifyController,
  type EntityMappingConfig,
  type FailedEntity,
  type VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { type Logger, Time } from "@matter/general";
import { Endpoint, type MutableEndpoint, ServerNodeStore } from "@matter/main";
import { DescriptorServer } from "@matter/main/behaviors";
import { Descriptor } from "@matter/main/clusters";
import {
  FabricManager,
  SessionManager,
  Subscription,
} from "@matter/main/protocol";
import { Service } from "../../core/ioc/service.js";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import {
  createEndpointId,
  type EntityEndpoint,
} from "../../matter/endpoints/entity-endpoint.js";
import { LegacyEndpoint } from "../../matter/endpoints/legacy/legacy-endpoint.js";
import { getVacuumServiceAreas } from "../../matter/endpoints/legacy/vacuum/behaviors/vacuum-service-area-server.js";
import { VacuumAreaSwitchEndpoint } from "../../matter/endpoints/legacy/vacuum/vacuum-area-switch.js";
import { updateEntityRegistry } from "../../matter/endpoints/update-entity-state.js";
import { validateEndpointType } from "../../matter/endpoints/validate-endpoint-type.js";
import { BUILTIN_PLUGINS } from "../../plugins/builtin/index.js";
import { PluginBasicInformationServer } from "../../plugins/plugin-basic-information-server.js";
import { PluginDeviceBehavior } from "../../plugins/plugin-behavior.js";
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
import { EntityMappingSync } from "./entity-mapping-sync.js";
import { IdentityResolver } from "./identity-resolver.js";

const MAX_ENTITY_ID_LENGTH = 150;

// Keep an endpoint this long after its entity leaves the registry. Slow
// integrations (zwave-js server updates take minutes) drop their entities
// well past a short grace, and deleting erases the persisted number, so
// controllers drop groups (#438). Cost: a really removed entity lingers 5min.
export const ENDPOINT_REMOVAL_GRACE_MS = 300_000;

// How long a refresh waits for the registry snapshots to land on the endpoints
// before moving on. Generous: the writes are only slow when they queue behind
// pending state writes, and giving up early just defers them to the next poll.
const REGISTRY_PUSH_TIMEOUT_MS = 10_000;

// Wait for the endpoint set to settle before comparing it. Covers the first
// registry tick after a start (60 s by default) and its reload, which mounts
// the entities whose state arrived late.
const TOPOLOGY_SETTLE_MS = 90_000;
// Prefix of the stored topology signature, changes with what it covers.
const TOPOLOGY_FORMAT = "v2:";
const TOPOLOGY_RETRIES = 3;
// A failed write retries soon, the set already settled before it.
const TOPOLOGY_RETRY_MS = 10_000;

// Same count as the registry's INCOMPLETE_REFRESH_RETRIES: one registry change
// retries a failing entity, after that the failure counts as permanent.
export const ENTITY_FAILURE_RETRIES = 3;

// First absence stamp: removal also needs a fresh successful HA reload after
// this, so the 65s recheck can never delete from the same stale snapshot.
export interface PendingRemoval {
  since: number;
  generation: number;
}

// An absent entity or area keeps its endpoint until the grace passed since
// it was first missed, HA has been up as long, and a newer snapshot still
// misses it (#438).
export function removalDue(
  entry: PendingRemoval,
  now: number,
  runningSince: number,
  generation: number,
): boolean {
  return !(
    now - entry.since < ENDPOINT_REMOVAL_GRACE_MS ||
    now - runningSince < ENDPOINT_REMOVAL_GRACE_MS ||
    generation <= entry.generation
  );
}

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

// Whether an attribute path selects Descriptor PartsList on the root or the
// aggregator, a missing id in a path being a wildcard.
export function selectsPartsList(paths: unknown, aggregator: number): boolean {
  if (!Array.isArray(paths)) return false;
  return paths.some(
    (p: { endpointId?: unknown; clusterId?: unknown; attributeId?: unknown }) =>
      (p?.endpointId == null ||
        p.endpointId === 0 ||
        p.endpointId === aggregator) &&
      (p?.clusterId == null || p.clusterId === Descriptor.Cluster.id) &&
      (p?.attributeId == null ||
        p.attributeId === Descriptor.Cluster.attributes.partsList.id),
  );
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
  private observingRequested = false;
  private _failedEntities: FailedEntity[] = [];
  private _refreshIncomplete = false;
  private _refreshDeferred = false;
  // last create or add failure per entity and how often it repeated in a row
  private readonly createFailures = new Map<
    string,
    { reason: string; count: number }
  >();
  private readonly mappingFingerprints = new Map<string, string>();
  private readonly mappingSync: EntityMappingSync;
  // entityId -> first absence stamp (grace window)
  private readonly pendingRemovals = new Map<string, PendingRemoval>();
  // area switch id -> first stamp its area was missing from the parent (#543)
  private areaSwitchRemovals = new Map<string, PendingRemoval>();
  private removalRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every stop, so a refresh that was already running cannot arm a
  // timer on a bridge that has since stopped (#438).
  private lifecycle = 0;
  private readonly pluginEndpoints = new Map<string, Endpoint>();
  private readonly pluginStateUpdating = new Map<string, number>();
  private readonly pluginListeners = new Map<string, PluginListenerRef[]>();
  private topologyChangeHandler = async (change: () => Promise<unknown>) => {
    await change();
  };
  // The handler writes the Matter configuration version, which takes a
  // synchronous lock on the root node. Two overlapping registrations would
  // make the second one throw and leave its endpoint mounted but untracked,
  // so every change goes through here one at a time.
  private topologyQueue: Promise<unknown> = Promise.resolve();
  // The endpoint set is only complete once both halves are in: the plugin
  // devices after startPlugins, the HA entities after a trusted reconcile.
  // Comparing earlier would announce a half set on every start.
  private pluginsStarted = false;
  private entitiesReconciled = false;
  // Last set a reconcile saw, so only a reconcile that moved it re-arms.
  private reconciledTopology = "";
  private topologyTimer: ReturnType<typeof setTimeout> | undefined;
  // a retry after a failed write must not bump the version a second time
  private announcedTopology = "";
  private topologyRetries = 0;

  private async enqueueTopology(run: () => Promise<unknown>): Promise<void> {
    const next = this.topologyQueue.then(run);
    this.topologyQueue = next.catch(() => undefined);
    await next;
  }

  private topologyKnown(): boolean {
    return this.pluginsStarted && this.entitiesReconciled;
  }

  private async topologyChange(change: () => Promise<unknown>): Promise<void> {
    await this.enqueueTopology(change);
    this.settleTopology();
  }

  // Every change re-arms the timer, so a start that passes through partial
  // sets (late states, #450 retry, #498 cleanup, area switches) compares once.
  private settleTopology(retry = false): void {
    if (!retry) this.topologyRetries = 0;
    if (!this.topologyKnown()) return;
    clearTimeout(this.topologyTimer);
    this.topologyTimer = setTimeout(
      () => {
        this.topologyTimer = undefined;
        void this.enqueueTopology(() => this.compareTopology());
      },
      retry ? TOPOLOGY_RETRY_MS : TOPOLOGY_SETTLE_MS,
    );
    this.topologyTimer.unref?.();
  }

  // Ids and Descriptor device types, child parts included, so a rebuild
  // under the same id with another device type counts as a change. Strict
  // throws on an unreadable part, so a compare retries it before hashing it
  // blank, a passing read failure would bump the version twice otherwise.
  private topologySignature(strict = false): string {
    const lines: string[] = [];
    const walk = (parts: Iterable<Endpoint>, prefix: string) => {
      for (const part of parts) {
        const id = `${prefix}${part.id}`;
        // an uninitialized or crashed part throws here, it must not fail
        // the whole refresh, so it counts with no device types
        let types: string[] = [];
        try {
          types = part
            .stateOf(DescriptorServer)
            .deviceTypeList.map((d) => `${d.deviceType}.${d.revision}`)
            .sort();
        } catch (e) {
          if (strict) throw e;
        }
        lines.push(`${id}=${types.join(",")}`);
        walk(part.parts, `${id}/`);
      }
    };
    walk(this.root.parts, "");
    const hash = createHash("sha256")
      .update(lines.sort().join("\n"))
      .digest("hex")
      .slice(0, 16);
    return `${TOPOLOGY_FORMAT}${hash}`;
  }

  // ConfigurationVersion has to move when the set of bridged endpoints does.
  // The last announced set lives in the node storage, so a restart with the
  // same endpoints announces nothing and a changed one announces once (#505).
  private async compareTopology(): Promise<void> {
    // a stop that began after the timer fired leaves a half unmounted set
    if (!this.topologyKnown()) return;
    try {
      const signature = this.topologySignature(
        this.topologyRetries < TOPOLOGY_RETRIES,
      );
      const storage = this.root.env
        .get(ServerNodeStore)
        .storage.createContext("hamh");
      const announced = await storage.get<string>("topology", "");
      if (announced === signature) return;
      // a first run only records the set, the version starts fresh anyway.
      // An older format counts as a first run, an upgrade must not bump.
      if (
        announced.startsWith(TOPOLOGY_FORMAT) &&
        this.announcedTopology !== signature
      ) {
        await this.topologyChangeHandler(async () => undefined);
        this.announcedTopology = signature;
      }
      await storage.set("topology", signature);
      this.announcedTopology = "";
      this.topologyRetries = 0;
    } catch (e) {
      this.log.warn("Failed to announce the bridge topology change:", e);
      if (this.topologyRetries < TOPOLOGY_RETRIES) {
        this.topologyRetries++;
        this.settleTopology(true);
      } else {
        this.log.warn(
          "Giving up on the bridge topology announcement until the endpoints change again",
        );
      }
    }
  }

  // Whether each controller held a subscription when the device list moved,
  // one that did not only sees the change when it subscribes again. A held
  // subscription does not prove the peer is still there (#545).
  private controllerFabricLines(): string[] {
    try {
      const env = this.root.env;
      const fabrics = env.maybeGet(FabricManager)?.fabrics ?? [];
      const aggregator = this.root.number;
      const counts = new Map<
        number,
        {
          sessions: number;
          subs: number;
          ids: string[];
          heard: number;
          heardAny: number;
          silent: boolean;
          covered: boolean;
        }
      >();
      // same clock as Session.activeTimestamp, milliseconds despite the name
      const now = Time.nowUs;
      for (const session of env.maybeGet(SessionManager)?.sessions ?? []) {
        const index = session.fabric?.fabricIndex;
        if (index === undefined) continue;
        const count = counts.get(index) ?? {
          sessions: 0,
          subs: 0,
          ids: [],
          heard: 0,
          heardAny: 0,
          silent: false,
          covered: false,
        };
        count.sessions++;
        count.subs += session.subscriptions.size;
        count.heardAny = Math.max(count.heardAny, session.activeTimestamp);
        let maxInterval = 0;
        for (const sub of session.subscriptions) {
          const s = sub as {
            subscriptionId?: number;
            maxInterval?: number;
            request?: { attributeRequests?: unknown };
          };
          count.ids.push(Subscription.idStrOf(s) ?? "?");
          maxInterval = Math.max(maxInterval, s.maxInterval ?? 0);
          count.covered ||= selectsPartsList(
            s.request?.attributeRequests,
            aggregator,
          );
        }
        // a session without a subscription that just talked must not hide a
        // subscribed one that went quiet
        if (session.subscriptions.size > 0 && session.activeTimestamp > 0) {
          count.heard = Math.max(count.heard, session.activeTimestamp);
          count.silent ||=
            maxInterval > 0 && now - session.activeTimestamp > maxInterval;
        }
        counts.set(index, count);
      }
      return fabrics.map((fabric) => {
        const { sessions, subs, ids, heard, heardAny, silent, covered } =
          counts.get(fabric.fabricIndex) ?? {
            sessions: 0,
            subs: 0,
            ids: [],
            heard: 0,
            heardAny: 0,
            silent: false,
            covered: false,
          };
        const vendor = fabric.rootVendorId;
        const name = classifyController(vendor) ?? "vendor";
        const last = subs > 0 ? heard : heardAny;
        const silence = now - last;
        let seen = sessions > 0 ? ", never heard" : "";
        if (last > 0) {
          const amount =
            silence < 120_000
              ? `${Math.round(silence / 1000)} s`
              : `${Math.round(silence / 60_000)} min`;
          seen = `, last heard ${amount} ago`;
          if (silent) seen += ", silent past its report interval";
        }
        const subIds = ids.length > 0 ? ` (sub# ${ids.join(", ")})` : "";
        const hint =
          subs === 0
            ? ", not subscribed, it sees the new device list when it subscribes again"
            : covered
              ? ""
              : ", device list not in its subscription";
        return `Controller fabric ${fabric.fabricIndex} (${name} 0x${vendor.toString(16)}): ${sessions} ${sessions === 1 ? "session" : "sessions"}, ${subs} ${subs === 1 ? "subscription" : "subscriptions"}${subIds}${seen}${hint}`;
      });
    } catch {
      return [];
    }
  }

  get failedEntities(): FailedEntity[] {
    // Combine static failed entities with dynamically isolated entities
    const isolated = EntityIsolationService.getIsolatedEntities(this.bridgeId);
    return [...this._failedEntities, ...isolated];
  }

  // True for the first failure with this reason, repeats log at debug. Only
  // the first retries mark the run incomplete, a failure that keeps coming
  // back would otherwise cost every registry change its full retry budget.
  private trackFailure(entityId: string, reason: string): boolean {
    const last = this.createFailures.get(entityId);
    const count = last?.reason === reason ? last.count + 1 : 1;
    this.createFailures.set(entityId, { reason, count });
    if (count <= ENTITY_FAILURE_RETRIES) this._refreshIncomplete = true;
    return count === 1;
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
    this.mappingSync = new EntityMappingSync(
      registry,
      (entityId) => this.getEntityMapping(entityId),
      log,
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

  setTopologyChangeHandler(
    handler: (change: () => Promise<unknown>) => Promise<void>,
  ): void {
    this.topologyChangeHandler = handler;
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
          return false;
        }
        const supplied = device.endpointType as Partial<MutableEndpoint>;
        const initialState: Record<string, object> = {};
        for (const cluster of device.clusters) {
          if (
            cluster.clusterId === "pluginDevice" &&
            supplied.behaviors?.pluginDevice == null &&
            supplied.behaviors?.bridgedDeviceBasicInformation == null
          ) {
            this.log.warn(
              `Plugin "${pluginName}": device "${device.id}" declares a "pluginDevice" cluster without owning that behavior, ignoring it`,
            );
            continue;
          }
          initialState[cluster.clusterId] = cluster.attributes;
        }
        // The plugin owns its clusters, but every endpoint under an
        // aggregator still needs BridgedDeviceBasicInformation or controllers
        // do not render it. Only add ours when the plugin brought none, and
        // only to a type that can take it: with()/set() are MutableEndpoint.
        const hasOwnIdentity =
          supplied.behaviors?.bridgedDeviceBasicInformation != null;
        // Our identity server reads PluginDeviceBehavior's state, so we can
        // only add it when that id is ours to define.
        const ownsPluginDevice = supplied.behaviors?.pluginDevice != null;
        const mutable =
          typeof supplied.with === "function" &&
          typeof supplied.set === "function";
        if (!mutable && Object.keys(initialState).length > 0) {
          // Mounting it would drop the cluster config the plugin asked for.
          this.log.warn(
            `Plugin "${pluginName}": endpointType for device "${device.id}" cannot take its cluster config, skipping it`,
          );
          return false;
        }
        if (!hasOwnIdentity && (!mutable || ownsPluginDevice)) {
          this.log.warn(
            `Plugin "${pluginName}": device "${device.id}" mounts without BridgedDeviceBasicInformation, controllers may not show it`,
          );
        }
        let base = device.endpointType as MutableEndpoint;
        if (mutable && !hasOwnIdentity && !ownsPluginDevice) {
          base = base.with(PluginBasicInformationServer, PluginDeviceBehavior);
          // after the cluster loop: a plugin cluster must not clobber this
          initialState.pluginDevice = { device, pluginName };
        }
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
          return false;
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
        await this.topologyChange(() => this.root.add(endpoint));
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
        return false;
      }
      return true;
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
            await this.topologyChange(() => endpoint.close());
          } else {
            await this.topologyChange(() => endpoint.delete());
          }
          this.log.info(`Plugin "${pluginName}": removed device "${deviceId}"`);
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
      // Counted: the first of two overlapping pushes must not unguard the other.
      this.pluginStateUpdating.set(
        deviceId,
        (this.pluginStateUpdating.get(deviceId) ?? 0) + 1,
      );
      endpoint
        .setStateOf(behaviorType, attributes)
        .catch((e) => {
          this.log.warn(
            `Plugin "${pluginName}": failed to update "${clusterId}" on "${deviceId}":`,
            e,
          );
        })
        .finally(() => {
          const left = (this.pluginStateUpdating.get(deviceId) ?? 1) - 1;
          if (left > 0) this.pluginStateUpdating.set(deviceId, left);
          else this.pluginStateUpdating.delete(deviceId);
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
    await this.registerBuiltInPlugins();
    await this.loadRegisteredPlugins();
    await this.pluginManager?.startAll();
    await this.pluginManager?.configureAll();
    this.pluginsStarted = true;
    this.settleTopology();
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
    // a stop is no topology change, the devices come back on the next start.
    // A pending compare is dropped, the next start compares against storage.
    this.pluginsStarted = false;
    clearTimeout(this.topologyTimer);
    this.topologyRetries = 0;
    if (!this.pluginManager) return;
    await this.pluginManager.shutdownAll("Bridge stopping");
    // close() keeps the numbers, so plugin devices survive every bridge stop
    // and restart (#438). Permanent removal goes through onDeviceUnregistered.
    for (const [id, endpoint] of this.pluginEndpoints) {
      try {
        await this.topologyChange(() => endpoint.close());
      } catch (e) {
        this.log.warn(`Failed to close plugin endpoint ${id}:`, e);
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

  async resetPlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.pluginManager?.resetPlugin(pluginName);
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
  isolateEntity(entityName: string): Promise<void> {
    // a running refresh works from its snapshot of the parts, so wait it out.
    // Nothing inside a refresh awaits this, the error handlers fire and forget.
    const next = this.refreshChain.then(() =>
      this.runIsolateEntity(entityName),
    );
    this.refreshChain = next.catch(() => undefined);
    return next;
  }

  private async runIsolateEntity(entityName: string): Promise<void> {
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
      // close(), not delete(): the number stays pre-allocated, so when the
      // next refresh recreates the endpoint it keeps its identity and
      // controllers keep their groups. A transient matter.js error must not
      // re-mint the device (#438).
      try {
        await endpoint.close();
      } catch (e) {
        this.log.error(`Failed to close isolated endpoint:`, e);
      }
      this.pendingRemovals.delete(endpoint.entityId);
      this.mappingFingerprints.delete(endpoint.entityId);
      if (!(endpoint instanceof VacuumAreaSwitchEndpoint)) {
        await this.closeAreaSwitchesOf(endpoint);
      }
    }
  }

  // Preserve room switch numbers across vacuum re-inclusion (#468).
  private async closeAreaSwitchesOf(vacuum: EntityEndpoint): Promise<void> {
    for (const sw of [...this.root.parts]) {
      if (!(sw instanceof VacuumAreaSwitchEndpoint)) continue;
      if (sw.vacuumEndpointId !== vacuum.id) continue;
      try {
        await sw.close();
      } catch (e) {
        this.log.warn(`Failed to remove area switch ${sw.id}:`, e);
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
    if (this.pendingRemovals.size === 0 && this.areaSwitchRemovals.size === 0)
      return;
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

  // battery, humidity and pressure skips from LegacyEndpoint.create
  private isAutoAssigned(entityId: string): boolean {
    const r = this.registry;
    return (
      (r.isAutoBatteryMappingEnabled() && r.isBatteryEntityUsed(entityId)) ||
      (r.isAutoHumidityMappingEnabled() && r.isHumidityEntityUsed(entityId)) ||
      (r.isAutoPressureMappingEnabled() && r.isPressureEntityUsed(entityId))
    );
  }

  private getEntityMapping(entityId: string): EntityMappingConfig | undefined {
    return this.mappingStorage.getMapping(this.bridgeId, entityId);
  }

  override async dispose(): Promise<void> {
    this.stopObserving();
    if (this.removalRecheckTimer) {
      clearTimeout(this.removalRecheckTimer);
      this.removalRecheckTimer = null;
    }
    this.pendingRemovals.clear();
    this.areaSwitchRemovals.clear();
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
    // Only the subscription resets here. stopObserving is the lifecycle stop
    // and would take the removal timer with it (#438).
    this.clearSubscription();
    // Wanting to observe and holding a subscription differ: a bridge started
    // while HA was down has no entities yet, and only this flag gets it
    // subscribed once the first trusted refresh brings them in.
    this.observingRequested = true;

    if (!this.entityIds.length) {
      return;
    }

    const subscriptionIds = this.collectSubscriptionEntityIds();
    this.unsubscribe = subscribeEntities(
      this.client.connection,
      (e, changed) =>
        this.updateStates(e, changed).catch((err) =>
          this.log.warn("State update failed:", err),
        ),
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
    for (const id of this.mappingSync.candidateSensorIds()) {
      ids.add(id);
    }
    return [...ids];
  }

  private clearSubscription() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  stopObserving() {
    this.observingRequested = false;
    this.entitiesReconciled = false;
    this.reconciledTopology = "";
    clearTimeout(this.topologyTimer);
    this.topologyRetries = 0;
    this.lifecycle++;
    this.clearSubscription();
    // Bridges stop through this, never through dispose(), so the recheck
    // timer has to die here or it deletes on a stopped bridge (#438).
    if (this.removalRecheckTimer) {
      clearTimeout(this.removalRecheckTimer);
      this.removalRecheckTimer = null;
    }
    this.mappingSync.cancelRetry();
  }

  // Start, update, the API, registry ticks and retry timers all refresh. Two
  // overlapping runs build every endpoint twice and the second add throws, so
  // runs queue up. Chained, not joined: a tick mid-run carries a newer registry.
  private refreshChain: Promise<unknown> = Promise.resolve();

  // Whether the last run skipped the reconcile because HA was down or the
  // registry empty, unlike the other incomplete runs it mounted nothing.
  get refreshDeferred(): boolean {
    return this._refreshDeferred;
  }

  // Resolves false when the run left matching entities unmounted for a reason
  // that only passes with time (HA down, heap pressure, a failed add).
  refreshDevices(): Promise<boolean> {
    const next = this.refreshChain.then(async () => {
      let complete = false;
      try {
        await this.runRefreshDevices();
        complete = !this._refreshIncomplete;
      } finally {
        // a start, an API refresh or a recheck needs the retry as much as a tick
        if (!complete) this.registry.markRefreshIncomplete();
      }
      return complete;
    });
    this.refreshChain = next.catch(() => undefined);
    return next;
  }

  private async runRefreshDevices() {
    this._refreshIncomplete = false;
    const wasDeferred = this._refreshDeferred;
    this._refreshDeferred = false;
    this.registry.refresh();
    const lifecycle = this.lifecycle;
    const wasLive = this.entitiesReconciled;

    // Area switches (#355) share the vacuum's entity_id but ride their own
    // reconcile pass keyed off the surviving vacuum endpoint, so they must never
    // enter the entity reconcile below (it would collide on entity_id).
    const endpoints = [...this.root.parts]
      .filter(hasEntityIdentity)
      .filter((p) => !(p instanceof VacuumAreaSwitchEndpoint));

    // HA restarting or an empty registry means the snapshot cannot be
    // trusted, not that every device was removed. Deleting now erases the
    // Matter numbers and controllers re-add everything, losing groups, and
    // identity resolution or tombstone stamping from it would corrupt
    // persisted records (#438). Keep the last good entity list and the
    // failures the UI shows, reset the grace, and wait for HA.
    const fullEntities = this.registry.fullEntities;
    if (!this.client.haRunning || Object.keys(fullEntities).length === 0) {
      this.pendingRemovals.clear();
      this.areaSwitchRemovals.clear();
      const message = `HA not running or registry empty, deferring reconcile of ${endpoints.length} endpoints`;
      // once per outage, the start gate retries every few seconds
      if (wasDeferred) this.log.debug(message);
      else this.log.warn(message);
      this._refreshIncomplete = true;
      this._refreshDeferred = true;
      return;
    }

    this._failedEntities = [];
    this.entityIds = this.registry.entityIds;
    const mountedBefore = new Set([...this.root.parts].map((p) => p.id));

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
    const resolvedByEntity = await this.identityResolver.resolveIdentities(
      this.bridgeId,
      this.entityIds.map((entityId) => ({
        entity_id: entityId,
        registry: this.registry.entity(entityId),
      })),
      (entityId) => this.getEntityMapping(entityId),
      stableIdentity,
      this.log,
      new Map(endpoints.map((e) => [e.entityId, e.id])),
    );
    const endpointIdToEntity = new Map<string, string>();
    // Carry the in-memory fingerprint to the new entity id so the create loop
    // does not read a spurious mapping change after a rename re-key. Only a
    // protected rename re-keys the mapping, and all old values are read first,
    // so a swap of two entity ids moves both.
    const carried: [string, string, string][] = [];
    for (const [entityId, resolved] of resolvedByEntity) {
      endpointIdToEntity.set(resolved.endpointId, entityId);
      const fp = resolved.renamedFrom
        ? this.mappingFingerprints.get(resolved.renamedFrom)
        : undefined;
      if (resolved.protected && fp !== undefined) {
        carried.push([resolved.renamedFrom!, entityId, fp]);
      }
    }
    for (const [from] of carried) this.mappingFingerprints.delete(from);
    for (const [, to, fp] of carried) this.mappingFingerprints.set(to, fp);

    // Reconcile orphan tombstones against the FULL HA registry (keyed by the
    // rename-stable identity key, so a rename, a filter change, or a scope
    // narrowing never reads as a removal). Stamp/clear only, never delete.
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

    const existingEndpoints: EntityEndpoint[] = [];
    const registryPushes: Promise<void>[] = [];
    const now = Date.now();
    // entities another live endpoint carries, or picks up when the mapping
    // check below rebuilds it, see the duplicate branch (#498)
    const carriedElsewhere = new Set(
      endpoints.flatMap((e) =>
        [
          ...(e.mappedEntityIds ?? []),
          this.registry.batteryFingerprintFor(
            e.entityId,
            this.getEntityMapping(e.entityId),
          ),
        ].filter((id) => id && id !== e.entityId),
      ),
    );
    for (const endpoint of endpoints) {
      const present = this.entityIds.includes(endpoint.entityId);

      // Rename: a different current entity now owns this endpoint's id while
      // this endpoint's own entity is gone, or the protected entity renamed off
      // it owns it while a new entity took the old name. close() keeps the
      // persisted number pre-allocated so the create loop rebuilds it under the
      // same id with the renamed entity. Never delete() here, that would erase
      // the number (#404).
      const claimant = endpointIdToEntity.get(endpoint.id);
      const renamed = claimant ? resolvedByEntity.get(claimant) : undefined;
      if (
        claimant != null &&
        claimant !== endpoint.entityId &&
        (!present ||
          (renamed?.protected && renamed.renamedFrom === endpoint.entityId))
      ) {
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
        // Filtered entities skip #438 grace; close() keeps number/groups
        // across re-inclusion (#468, #404).
        if (fullEntities[endpoint.entityId] != null) {
          this.log.info(
            `Entity ${endpoint.entityId} is no longer exposed by the filter, removing endpoint ${endpoint.number}`,
          );
          try {
            await endpoint.close();
          } catch (e) {
            this.log.warn(
              `Failed to remove filtered endpoint ${endpoint.entityId}:`,
              e,
            );
          }
          await this.closeAreaSwitchesOf(endpoint);
          this.mappingFingerprints.delete(endpoint.entityId);
          this.pendingRemovals.delete(endpoint.entityId);
          continue;
        }
        // An entity can vanish from the registry briefly during an HA restart.
        // delete() erases the persisted endpoint number, so controllers (Alexa)
        // treat the recreated device as new and lose groups. Wait out a grace
        // window AND a fresh successful HA reload before removing it for good.
        const entry = this.pendingRemovals.get(endpoint.entityId);
        if (entry == null) {
          this.pendingRemovals.set(endpoint.entityId, {
            since: now,
            generation: this.registry.snapshotGeneration,
          });
          existingEndpoints.push(endpoint);
          continue;
        }
        if (
          !removalDue(
            entry,
            now,
            this.client.runningSince,
            this.registry.snapshotGeneration,
          )
        ) {
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
        // absorbed into an air purifier). Drop the standalone endpoint so the
        // composed device is the only representation (#218). close(), not
        // delete(): turning the flag back off must return the same number.
        this.log.info(
          `Removing standalone endpoint ${endpoint.entityId}, consumed by composed device`,
        );
        try {
          await endpoint.close();
        } catch (e) {
          this.log.warn(
            `Failed to remove composed sub-entity endpoint ${endpoint.entityId}:`,
            e,
          );
        }
        this.mappingFingerprints.delete(endpoint.entityId);
      } else if (
        carriedElsewhere.has(endpoint.entityId) &&
        this.isAutoAssigned(endpoint.entityId)
      ) {
        // A refresh that saw the battery sensor unavailable built it its own
        // endpoint, which nothing removed once the sensor came back. Its
        // device already shows it, so drop the duplicate (#498).
        this.log.info(
          `Removing standalone endpoint ${endpoint.entityId}, auto-mapped onto another device`,
        );
        try {
          await endpoint.close();
        } catch (e) {
          this.log.warn(
            `Failed to remove auto-mapped endpoint ${endpoint.entityId}:`,
            e,
          );
        }
        this.mappingFingerprints.delete(endpoint.entityId);
      } else {
        // Check if the mapping changed since the endpoint was created.
        // If so, delete the old endpoint so it gets recreated with the new config.
        const currentMapping = this.getEntityMapping(endpoint.entityId);
        const storedFp = this.mappingFingerprints.get(endpoint.entityId) ?? "";
        const currentFp = this.mappingSync.compareFingerprint(
          currentMapping,
          endpoint.entityId,
          storedFp,
        );
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
          // The endpoint survives, so nothing rebuilds its Home Assistant
          // registry snapshot. Push the current one, or a device renamed in
          // Home Assistant (and its manufacturer, model or firmware version)
          // would stay on the values it was created with until a restart
          // (#467). No-op when nothing moved.
          registryPushes.push(
            updateEntityRegistry(
              endpoint,
              this.registry.entity(endpoint.entityId),
              this.registry.deviceOf(endpoint.entityId),
            ).catch((e) =>
              this.log.warn(
                `Failed to refresh the registry snapshot of ${endpoint.entityId}:`,
                e,
              ),
            ),
          );
          existingEndpoints.push(endpoint);
        }
      }
    }

    // Concurrently, and awaited so a caller that reads attributes right after a
    // refresh sees the new snapshot. Each push returns before taking the
    // endpoint lock when nothing changed, which is the normal case.
    //
    // Bounded: a push waits for construction and queues behind the pending
    // state writes of its endpoint, and refreshDevices is also reached from the
    // API and from bridge start. One endpoint that never settles must not stall
    // the whole refresh, the next poll pushes the same snapshot again.
    if (registryPushes.length > 0) {
      await Promise.race([
        Promise.all(registryPushes),
        new Promise<void>((resolve) =>
          setTimeout(resolve, REGISTRY_PUSH_TIMEOUT_MS).unref?.(),
        ),
      ]);
    }

    // A stop that landed mid-refresh wins: no timer on a stopped bridge.
    if (lifecycle === this.lifecycle) {
      this.scheduleRemovalRecheck();
    }

    let memoryLimitReached = false;
    const waiting: string[] = [];

    for (const entityId of this.entityIds) {
      // Check heap pressure before creating a new endpoint.
      // matter.js endpoints are memory-heavy (~1-3 MB each), so we stop
      // loading more entities when the heap approaches its limit to
      // prevent OOM crashes. Already-loaded endpoints keep working.
      if (!memoryLimitReached && isHeapUnderPressure()) {
        memoryLimitReached = true;
        this.log.error(
          "Memory pressure detected, skipping remaining entities to prevent OOM crash. " +
            "Reduce the number of entities in this bridge or raise the heap (add-on: heap_size_mb option, container: NODE_OPTIONS=--max-old-space-size=1024).",
        );
      }
      if (memoryLimitReached) {
        // Skip existing endpoints that are already loaded
        if (!existingEndpoints.some((e) => e.entityId === entityId)) {
          this._refreshIncomplete = true;
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
        // matter.js rejects duplicate endpoint ids, say which entity holds it
        const resolved = resolvedByEntity.get(entityId);
        const endpointId =
          resolved?.endpointId ??
          createEndpointId(entityId, mapping?.customName);
        const holder = this.root.parts.find(
          (p) =>
            p.id === endpointId &&
            (p as Partial<EntityEndpoint>).entityId !== entityId,
        ) as Partial<EntityEndpoint> | undefined;
        if (holder) {
          this.addFailedEntity(
            entityId,
            `Endpoint id collides with ${holder.entityId ?? holder.id}. Set distinct custom names.`,
          );
          continue;
        }
        try {
          const domainMappings = this.getPluginDomainMappings();
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
          const message = `Failed to create device ${entityId}: ${reason}`;
          if (this.trackFailure(entityId, reason)) {
            this.log.warn(message);
          } else {
            this.log.debug(message);
          }
          this.addFailedEntity(entityId, reason);
          continue;
        }

        if (endpoint) {
          try {
            await this.root.add(endpoint);
            // Isolation closed the old endpoint, this one starts clean. The
            // record keys on the part id or the entity id the error named.
            EntityIsolationService.clearIsolatedEntity(
              this.bridgeId,
              endpoint.id,
            );
            EntityIsolationService.clearIsolatedEntity(this.bridgeId, entityId);
            this.mappingFingerprints.set(
              entityId,
              this.mappingSync.fingerprintAsBuilt(
                mapping,
                entityId,
                endpoint.mappedEntityIds,
              ),
            );
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            const reason = this.extractErrorReason(e);
            const message = `Failed to add endpoint for ${entityId}: ${errorMessage}`;
            // Handle all endpoint initialization errors gracefully
            if (this.trackFailure(entityId, reason)) {
              this.log.warn(message);
              // Extract detailed behavior error info for debugging
              this.logDetailedError(entityId, e);
            } else {
              this.log.debug(message);
            }
            this.addFailedEntity(entityId, reason);
          }
        } else if (!this.registry.initialState(entityId)) {
          // the registry poll that brings its state mounts it, no retry needed
          const reason = "No state in Home Assistant yet";
          if (this.createFailures.get(entityId)?.reason !== reason) {
            this.createFailures.set(entityId, { reason, count: 1 });
            waiting.push(entityId);
          }
          this.addFailedEntity(entityId, reason);
        }
      }
    }

    if (waiting.length > 0) {
      const one = waiting.length === 1;
      const more = waiting.length > 5 ? ` and ${waiting.length - 5} more` : "";
      this.log.info(
        `No state in Home Assistant yet for ${waiting.length} matched ${one ? "entity, it is added once it has" : "entities, they are added once they have"} one: ${waiting.slice(0, 5).join(", ")}${more}`,
      );
    }

    // a success or an entity that left the pass starts its count over
    for (const id of this.createFailures.keys()) {
      if (!this._failedEntities.some((f) => f.entityId === id)) {
        this.createFailures.delete(id);
      }
    }

    await this.reconcileAreaSwitches();

    // Again for the area switch removals the reconcile just held.
    if (lifecycle === this.lifecycle) {
      this.scheduleRemovalRecheck();
    }

    this.mappingSync.rebuildCandidates(
      [...this.root.parts].filter(hasEntityIdentity).flatMap((p) => {
        const fp = this.mappingFingerprints.get(p.entityId);
        return fp === undefined ? [] : [[p.entityId, fp] as [string, string]];
      }),
    );

    // One line when the mounted set moves, so a log or export shows whether
    // the bridge changed what controllers see (#500, #505).
    const mountedNow = new Set([...this.root.parts].map((p) => p.id));
    const added = [...mountedNow].filter((id) => !mountedBefore.has(id));
    const removed = [...mountedBefore].filter((id) => !mountedNow.has(id));
    if (added.length + removed.length > 0) {
      // removals name their entity in their own lines, additions only here
      const names =
        added.length > 0
          ? ` (${added.slice(0, 10).join(", ")}${added.length > 10 ? ", ..." : ""})`
          : "";
      this.log.info(
        `Device list changed: ${removed.length} removed, ${added.length} added${names}, ${mountedNow.size} mounted`,
      );
      if (wasLive) {
        for (const line of this.controllerFabricLines()) this.log.info(line);
      }
    }
    // Not added/removed: an isolation closes endpoints between reconciles.
    if (lifecycle === this.lifecycle) {
      this.entitiesReconciled = true;
      const topology = this.topologySignature();
      if (topology !== this.reconciledTopology) {
        this.reconciledTopology = topology;
        this.settleTopology();
      }
    }

    if (this.observingRequested) {
      this.startObserving().catch((e) =>
        this.log.warn("Failed to subscribe to entity states:", e),
      );
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
  // deleted when the flag goes off, the area stays gone past the removal
  // grace, or the parent is gone.
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
    // only switches still missing their area carry their stamp over
    const missingBefore = this.areaSwitchRemovals;
    this.areaSwitchRemovals = new Map();
    const now = Date.now();
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
        } else {
          // A vacuum rebuilt while unavailable can list fewer rooms, and
          // delete() would give the switch a new number when the room returns.
          const entry = missingBefore.get(sw.id) ?? {
            since: now,
            generation: this.registry.snapshotGeneration,
          };
          if (
            !removalDue(
              entry,
              now,
              this.client.runningSince,
              this.registry.snapshotGeneration,
            )
          ) {
            this.areaSwitchRemovals.set(sw.id, entry);
            keep = true;
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
          EntityIsolationService.clearIsolatedEntity(this.bridgeId, switchId);
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
    this.registry.mergeExternalStates(states, changed);

    this.mappingSync.maybeRetry(states, changed, this.observingRequested, () =>
      this.refreshDevices().then(() => undefined),
    );

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
