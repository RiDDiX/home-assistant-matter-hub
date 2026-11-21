import {
  BridgeStatus,
  type ExposedDeviceType,
  type FailedEntity,
  type UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import type { Endpoint } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors";
import { AdministratorCommissioning } from "@matter/main/clusters";
import { CommissioningServer, type ServerNode } from "@matter/main/node";
import {
  DeviceCommissioner,
  FabricManager,
  SessionManager,
} from "@matter/main/protocol";
import type { BetterLogger } from "../../core/app/logger.js";
import { updateEntityState } from "../../matter/endpoints/update-entity-state.js";
import {
  applyLegacySpecSessionParameters,
  specVersionValues,
} from "../../matter/legacy-spec-version.js";
import { applyTcpFlagBeforeStart } from "../../plugins/builtin/camera/camera-tcp-requirement.js";
import { ensureCommissioningConfig } from "../../utils/ensure-commissioning-config.js";
import { isHeapUnderPressure, logMemoryUsage } from "../../utils/log-memory.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import { HomeAssistantRegistry } from "../home-assistant/home-assistant-registry.js";
import type {
  BridgeDataProvider,
  BridgeServerStatus,
} from "./bridge-data-provider.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { SessionSupervisor } from "./session-supervisor.js";

// Auto Force Sync interval in milliseconds (90 seconds).
// When autoForceSync is enabled, this pushes changed entity states to
// Matter controllers. matter.js handles subscription keepalive internally
// via empty DataReports every ~sendInterval.
const AUTO_FORCE_SYNC_INTERVAL_MS = 90_000;

// a start whose server.start never settles must not block stop, and with it
// dispose and shutdown
const START_WAIT_MS = 60_000;

// a node that goes online before HA is ready shows controllers an empty set
// and every device comes back a refresh later (#543). A stop ends the wait,
// shutdown has only a few seconds.
const HA_READY_WAIT_MS = 30_000;
// a paired controller sees an empty start as every device removed, and HA
// can take minutes to run after a host reboot
export const HA_READY_WAIT_COMMISSIONED_MS = 10 * 60_000;
const HA_READY_POLL_MS = 3000;
// bridges start one after the other, once one gave up the others do not
// wait the full time again for the same HA outage. Only for a while: HA can
// recover through the auto-refresh, which never clears it, and fail again.
const HA_WAIT_GAVE_UP_MS = 2 * 60_000;
let haWaitGaveUpAt = Number.NEGATIVE_INFINITY;
// a short give up must not cut a commissioned bridge's longer wait
let haWaitGaveUpBound = 0;

// matter.js closes the window of an unpaired node after 48 h without telling
// anyone, so a running bridge checks for that and reopens it
export const COMMISSIONING_CHECK_MS = 10 * 60_000;

interface LifecycleEndpointManager {
  readonly failedEntities: FailedEntity[];
  readonly refreshDeferred: boolean;
  readonly waitingForAllocatedEndpointState: boolean;
  refreshDevices(): Promise<boolean>;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

/**
 * Lifecycle shared by the aggregator Bridge and the ServerModeBridge, so
 * guards added to one cannot be missing from the other again.
 */
export abstract class BridgeBase<
  S extends ServerNode & {
    factoryReset(): Promise<void>;
    eraseOnline?: () => Promise<void>;
  },
  M extends LifecycleEndpointManager,
> {
  protected readonly sessions: SessionSupervisor;

  protected status: BridgeServerStatus = {
    code: BridgeStatus.Stopped,
    reason: undefined,
  };

  // Called whenever the bridge status changes. Set by BridgeService to
  // broadcast updates via WebSocket so the frontend sees every transition
  // (e.g. Stopped → Starting → Running).
  public onStatusChange?: () => void;

  private autoForceSyncTimer: ReturnType<typeof setInterval> | null = null;
  private commissioningCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Serialize concurrent lifecycle calls so auto-recovery and a manual
  // restartBridge can't race past each other's Starting/Stopping states.
  private startInFlight?: Promise<void>;
  private stopInFlight?: Promise<void>;
  private timedOutStartTeardown?: Promise<void>;
  // a stop during a start: the start does not take the node online
  private stopRequest?: symbol;
  private startedFor?: symbol;
  private resetInFlight?: Promise<void>;
  private wakeHaWait?: () => void;

  // Tracks the last synced state JSON per entity to avoid pushing unchanged states.
  // Key: entity_id, Value: JSON.stringify of entity.state
  protected readonly lastSyncedStates = new Map<string, string>();

  protected constructor(
    protected readonly log: BetterLogger,
    protected readonly dataProvider: BridgeDataProvider,
    protected readonly endpointManager: M,
    readonly server: S,
    sessionMaxAgeHours: number,
  ) {
    this.sessions = new SessionSupervisor(
      log,
      server,
      dataProvider,
      () => this.data,
      sessionMaxAgeHours,
    );
    server.eraseOnline = () => this.resetAfterLastFabric();
  }

  /** "Bridge" or "Server mode bridge", for status reasons and events. */
  protected abstract get label(): string;

  /** The device endpoints directly under the node or the aggregator. */
  protected abstract topLevelEndpoints(): Endpoint[];

  /** Runs right before server.start, once the endpoints are mounted. */
  protected async onServerStarting(): Promise<void> {}

  /** Runs after server.start, before the bridge reports Running. */
  protected async onServerStarted(): Promise<void> {}

  /** Runs after the controller sessions closed, before the node cancels. */
  protected async onServerStopping(): Promise<void> {}

  get id(): string {
    return this.dataProvider.id;
  }

  get data() {
    return this.dataProvider.withMetadata(
      this.status,
      this.server,
      this.topLevelEndpoints().length,
      this.endpointManager.failedEntities,
      this.getExposedDeviceTypes(),
    );
  }

  /**
   * The entity id and numeric Matter device type of every exposed endpoint,
   * walking composed sub-endpoints. Used to warn when a device type is not
   * supported by a commissioned controller (#365 class).
   */
  getExposedDeviceTypes(): ExposedDeviceType[] {
    const out: ExposedDeviceType[] = [];
    const collect = (ep: Endpoint, inheritedEntityId?: string) => {
      const entityId =
        (ep as { entityId?: string }).entityId ?? inheritedEntityId;
      const deviceTypeId = ep.type?.deviceType;
      if (typeof deviceTypeId === "number" && entityId) {
        out.push({ entityId, deviceTypeId });
      }
      for (const child of ep.parts) {
        collect(child, entityId);
      }
    };
    for (const ep of this.topLevelEndpoints()) {
      collect(ep);
    }
    return out;
  }

  getSessionInfo() {
    return this.sessions.getSessionInfo();
  }

  async initialize(): Promise<void> {
    await this.server.construction.ready.then();
    await this.refreshDevices();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  /** Resolves false when matching entities stayed unmounted for a transient reason. */
  async refreshDevices(tick = false): Promise<boolean> {
    let complete = false;
    try {
      complete = await this.endpointManager.refreshDevices();
    } finally {
      // a start, update or API refresh earns new retries, a tick never does
      if (!complete && !tick) {
        this.server.env.maybeGet(BridgeRegistry)?.grantRefreshRetries();
      }
    }
    // Prune stale entries from lastSyncedStates for entities that were removed
    const currentEntityIds = new Set(
      this.topLevelEndpoints().map(
        (p) => (p as { entityId?: string }).entityId,
      ),
    );
    for (const entityId of this.lastSyncedStates.keys()) {
      if (!currentEntityIds.has(entityId)) {
        this.lastSyncedStates.delete(entityId);
      }
    }
    return complete;
  }

  private setStatus(status: BridgeServerStatus) {
    this.status = status;
    this.onStatusChange?.();
  }

  private get stopRequested() {
    return this.stopRequest !== this.startedFor;
  }

  async start(): Promise<void> {
    const stopRequest = this.stopRequest;
    if (this.stopInFlight || this.timedOutStartTeardown) {
      await this.stopInFlight;
      await this.startInFlight;
      if (this.stopRequest !== stopRequest) return;
    }
    if (this.status.code === BridgeStatus.Running) {
      return;
    }
    if (this.startInFlight) {
      return this.startInFlight;
    }
    this.startInFlight = this.runStart().finally(() => {
      this.startInFlight = undefined;
      this.timedOutStartTeardown = undefined;
    });
    return this.startInFlight;
  }

  protected async runStart(): Promise<void> {
    this.lastSyncedStates.clear();
    this.startedFor = this.stopRequest;
    try {
      this.setStatus({
        code: BridgeStatus.Starting,
        reason: `The ${this.label.toLowerCase()} is starting... Please wait.`,
      });
      await this.refreshDevices();
      await this.waitForHomeAssistant();
      if (this.stopRequested) return;
      logMemoryUsage(
        this.log,
        `after refreshDevices (${this.topLevelEndpoints().length} endpoints)`,
      );
      this.endpointManager
        .startObserving()
        .catch((e) =>
          this.log.warn("Failed to subscribe to entity states:", e),
        );
      ensureCommissioningConfig(this.server);
      // before start: a fast commissioner can PASE immediately, and a node
      // kept across a flag change must follow the flag (#449)
      applyLegacySpecSessionParameters(
        this.server.env.get(SessionManager),
        this.dataProvider.featureFlags,
      );
      await this.server.setStateOf(
        BasicInformationServer,
        specVersionValues(this.dataProvider.featureFlags),
      );
      await applyTcpFlagBeforeStart(
        this.server,
        this.dataProvider.featureFlags,
      );
      // the node keeps its constructor port across cancel/start, a port edit
      // only reached BridgeData
      if (this.server.state.network.port !== this.dataProvider.port) {
        await this.server.set({ network: { port: this.dataProvider.port } });
      }
      await this.onServerStarting();
      if (this.stopRequested) return;
      await this.server.start();
      if (this.stopRequested) return;
      await this.onServerStarted();
      if (this.stopRequested) return;
      this.setStatus({ code: BridgeStatus.Running });
      this.startAutoForceSyncIfEnabled();

      // Force sync immediately on startup to push current HA state to controllers
      // before they reconnect and execute any queued commands
      if (this.dataProvider.featureFlags?.autoForceSync) {
        this.forceSync().catch((e) => {
          this.log.warn("Startup force sync failed:", e);
        });
      }

      this.sessions.start();
      this.commissioningCheckTimer = setInterval(
        () => this.reopenExpiredCommissioning(),
        COMMISSIONING_CHECK_MS,
      );
      logMemoryUsage(this.log, `${this.label.toLowerCase()} running`);
      this.log.info(`${this.label} started`);
      diagnosticEventBus.emit("bridge_started", `${this.label} started`, {
        bridgeId: this.id,
        bridgeName: this.dataProvider.name,
        details: { deviceCount: this.topLevelEndpoints().length },
      });
    } catch (e) {
      const reason = `Failed to start ${this.label.toLowerCase()} due to error:`;
      this.log.error(reason, e);
      if (this.stopRequested) return;
      await this.runStop();
      if (!this.stopRequested) {
        this.publishStop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
      }
    } finally {
      if (this.timedOutStartTeardown) {
        // A late start can bring the node back online after the first teardown.
        this.timedOutStartTeardown = this.timedOutStartTeardown
          .catch(() => {})
          .then(() => this.runStop());
        await this.timedOutStartTeardown;
      }
    }
  }

  private async waitForHomeAssistant(): Promise<void> {
    const since = Date.now();
    const commissioned =
      (this.endpointManager.refreshDeferred ||
        this.endpointManager.waitingForAllocatedEndpointState) &&
      this.server.env.get(FabricManager).length > 0;
    const missingAllocatedState = () =>
      commissioned && this.endpointManager.waitingForAllocatedEndpointState;
    const waiting = () =>
      this.endpointManager.refreshDeferred || missingAllocatedState();
    // with HA running a missing state is a snapshot race a reload fixes in
    // seconds, a longer wait only holds back the bridges started after this one
    const bound =
      commissioned && this.endpointManager.refreshDeferred
        ? HA_READY_WAIT_COMMISSIONED_MS
        : HA_READY_WAIT_MS;
    const deadline = since + bound;
    let nextInfo = since + 60_000;
    let reload: Promise<unknown> | undefined;
    while (waiting() && !this.stopRequested) {
      const left = deadline - Date.now();
      const gaveUp =
        this.endpointManager.refreshDeferred &&
        Date.now() - haWaitGaveUpAt < HA_WAIT_GAVE_UP_MS &&
        haWaitGaveUpBound >= bound;
      if (left <= 0 || gaveUp) {
        this.log.warn(
          `Home Assistant data not ready${gaveUp ? "" : ` after ${bound / 1000}s`}, starting with what the bridge has`,
        );
        if (!gaveUp && this.endpointManager.refreshDeferred) {
          haWaitGaveUpAt = Date.now();
          haWaitGaveUpBound = bound;
        }
        return;
      }
      if (Date.now() >= nextInfo) {
        this.log.info(
          `Waiting for Home Assistant data, ${Math.round((Date.now() - since) / 1000)}s of ${bound / 1000}s`,
        );
        nextInfo += 60_000;
      }
      // Auto-refresh starts after all bridges, so fetch missing registry data here.
      const registry = this.server.env.maybeGet(HomeAssistantRegistry);
      if (
        !reload &&
        registry &&
        (missingAllocatedState() || Object.keys(registry.entities).length === 0)
      ) {
        reload = registry
          .reload()
          .catch((e) => this.log.debug("Registry reload failed:", e))
          .finally(() => {
            reload = undefined;
          });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(HA_READY_POLL_MS, left));
        this.wakeHaWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeHaWait = undefined;
      if (!this.stopRequested) await this.refreshDevices();
    }
    if (!waiting()) {
      haWaitGaveUpAt = Number.NEGATIVE_INFINITY;
    }
  }

  private async waitForStart(onTimeout?: () => void): Promise<void> {
    const start = this.startInFlight;
    if (!start) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), START_WAIT_MS);
    });
    try {
      if ((await Promise.race([start, bound])) === "timeout") {
        onTimeout?.();
        this.log.warn(
          `${this.id}: start still pending after ${START_WAIT_MS / 1000}s, stopping anyway`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(
    code: BridgeStatus = BridgeStatus.Stopped,
    reason = "Manually stopped",
  ): Promise<void> {
    this.stopRequest = Symbol();
    this.wakeHaWait?.();
    if (this.stopInFlight) {
      return this.stopInFlight;
    }
    const previousTeardown = this.timedOutStartTeardown;
    const ready = previousTeardown
      ? previousTeardown.catch(() => {})
      : this.waitForStart(() => {
          this.timedOutStartTeardown = this.stopInFlight;
        });
    this.stopInFlight = ready
      .then(async () => {
        await this.runStop();
        this.publishStop(code, reason);
      })
      .finally(() => {
        this.stopInFlight = undefined;
      });
    if (previousTeardown) this.timedOutStartTeardown = this.stopInFlight;
    return this.stopInFlight;
  }

  protected async runStop(): Promise<void> {
    this.sessions.stop();
    this.stopAutoForceSync();
    if (this.commissioningCheckTimer) {
      clearInterval(this.commissioningCheckTimer);
      this.commissioningCheckTimer = null;
    }
    await this.sessions.closeActiveSessions();
    await this.onServerStopping();
    this.endpointManager.stopObserving();
    try {
      await this.server.cancel();
    } catch (e) {
      // Ignore mutex-closed errors during shutdown - this is expected
      // when the environment is being disposed
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (
        !errorMessage.includes("mutex-closed") &&
        !errorMessage.includes("mutex is closed")
      ) {
        this.log.warn(`Error stopping ${this.label.toLowerCase()}:`, e);
      }
    }
  }

  private publishStop(code: BridgeStatus, reason: string): void {
    this.setStatus({ code, reason });
    diagnosticEventBus.emit(
      "bridge_stopped",
      `${this.label} stopped: ${reason}`,
      {
        bridgeId: this.id,
        bridgeName: this.dataProvider.name,
      },
    );
  }

  private startAutoForceSyncIfEnabled() {
    // Stop any existing timer first
    this.stopAutoForceSync();

    const forceSyncEnabled =
      this.dataProvider.featureFlags?.autoForceSync ?? false;

    if (!forceSyncEnabled) {
      return;
    }

    // Force sync pushes changed entity states to Matter controllers.
    // matter.js handles subscription keepalive internally via empty DataReports.
    this.autoForceSyncTimer = setInterval(() => {
      this.forceSync().catch((e) => {
        this.log.warn("Auto force sync failed:", e);
      });
    }, AUTO_FORCE_SYNC_INTERVAL_MS);

    this.log.info(`Force sync: every ${AUTO_FORCE_SYNC_INTERVAL_MS / 1000}s`);
  }

  private stopAutoForceSync() {
    if (this.autoForceSyncTimer) {
      clearInterval(this.autoForceSyncTimer);
      this.autoForceSyncTimer = null;
    }
  }

  async update(update: UpdateBridgeRequest): Promise<void> {
    // a port edit during Starting would skip the rebind below
    await this.waitForStart();
    try {
      const { code } = this.status;
      const rebind =
        update.port !== this.dataProvider.port &&
        (code === BridgeStatus.Running || code === BridgeStatus.Failed);
      this.dataProvider.update(update);
      if (rebind) {
        await this.stop(BridgeStatus.Stopped, "Port changed");
        await this.start();
        return;
      }
      await this.refreshDevices();
      // Re-evaluate auto force sync and session rotation after config update,
      // not on a bridge a stop is taking down, it sets the status last
      if (this.status.code === BridgeStatus.Running && !this.stopInFlight) {
        this.startAutoForceSyncIfEnabled();
        // Re-read sessionMaxAgeHours so UI changes apply without restart (#287)
        this.sessions.reconfigure();
      }
    } catch (e) {
      const reason = `Failed to update ${this.label.toLowerCase()} due to error:`;
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  // beforeReset runs only after a successful erase, so a bridge that stopped
  // after the caller looked or failed to erase keeps what beforeReset drops.
  async factoryReset(beforeReset?: () => Promise<void>): Promise<boolean> {
    // A second request mid reset joins the first, it must not erase again.
    if (this.resetInFlight) {
      await this.resetInFlight;
      return true;
    }
    if (this.status.code !== BridgeStatus.Running) {
      return false;
    }
    await this.runReset(beforeReset);
    return true;
  }

  private runReset(beforeReset?: () => Promise<void>) {
    this.resetInFlight ??= this.runFactoryReset(beforeReset).finally(() => {
      this.resetInFlight = undefined;
    });
    return this.resetInFlight;
  }

  private async runFactoryReset(beforeReset?: () => Promise<void>) {
    const stopped = this.stopRequested;
    // Regular stop first, or the restart rejects every plugin as already
    // registered (#477, #478).
    const stopping = this.stop(BridgeStatus.Stopped, "Factory reset");
    // only a stop or delete from here on keeps the bridge down
    if (!stopped) this.startedFor = this.stopRequest;
    await stopping;
    try {
      await this.server.factoryReset();
      await beforeReset?.();
    } catch (e) {
      this.log.error(`${this.id}: factory reset failed:`, e);
      // auto-recovery restarts only a Failed bridge
      if (!this.stopRequested) {
        await this.stop(
          BridgeStatus.Failed,
          `Factory reset failed:\n${e?.toString()}`,
        ).catch((e) =>
          this.log.error(`${this.id}: stop after failed reset:`, e),
        );
      }
      throw e;
    }
    if (this.stopRequested) return;
    await this.start();
  }

  // the node's erase hands an online reset here, matter.js runs it once the
  // last fabric is gone and its rejection would crash the runtime
  private async resetAfterLastFabric(): Promise<void> {
    try {
      await this.runReset();
    } catch (e) {
      this.log.error(
        `${this.id}: factory reset after the last fabric failed:`,
        e,
      );
    }
  }

  private async reopenExpiredCommissioning() {
    try {
      // a fabric exists from AddNOC on, so this also skips a pairing that is
      // finishing and not yet marked commissioned
      if (
        this.status.code !== BridgeStatus.Running ||
        this.server.env.get(FabricManager).length > 0 ||
        this.server.env.get(DeviceCommissioner).windowStatus !==
          AdministratorCommissioning.CommissioningWindowStatus.WindowNotOpen
      ) {
        return;
      }
      await this.server.act((agent) =>
        agent.get(CommissioningServer).enterCommissionableMode(),
      );
      this.log.info("Commissioning window expired before pairing, reopened it");
    } catch (e) {
      this.log.warn("Reopening commissioning failed:", e);
    }
  }

  /**
   * Open a basic commissioning window so additional controllers can pair.
   * After first commissioning the bridge stops advertising; this re-enables
   * mDNS commissionable advertising with the original passcode/discriminator
   * for the standard 15-minute window.
   */
  async openCommissioningWindow(): Promise<void> {
    if (this.status.code !== BridgeStatus.Running) {
      throw new Error("Bridge is not running");
    }
    const commissioning = this.server.state.commissioning;
    if (!commissioning.commissioned) {
      throw new Error("Bridge is not yet commissioned");
    }
    await this.server.act((agent) =>
      agent.get(CommissioningServer).enterCommissionableMode(),
    );
    this.log.info("Opened basic commissioning window for multi-fabric pairing");
  }

  /**
   * Force sync all device states to connected controllers.
   * Only pushes state for endpoints whose entity state has actually changed
   * since the last sync. This avoids unnecessary MRP traffic that could
   * trigger session loss during brief network interruptions.
   */
  async forceSync(): Promise<number> {
    if (this.status.code !== BridgeStatus.Running) {
      return 0;
    }

    if (!this.dataProvider.featureFlags?.autoForceSync) {
      return 0;
    }

    if (isHeapUnderPressure()) {
      this.log.warn(
        "Force sync skipped: heap under pressure, reduce entities or raise the heap (add-on: heap_size_mb, container: NODE_OPTIONS=--max-old-space-size)",
      );
      return 0;
    }

    // Import dynamically to avoid circular dependencies
    const { HomeAssistantEntityBehavior } = await import(
      "../../matter/behaviors/home-assistant-entity-behavior.js"
    );

    // Collect all endpoints recursively to include sub-endpoints
    // of composed devices (e.g., ComposedSensorEndpoint has T/H/P sub-endpoints)
    const allEndpoints: Endpoint[] = [];
    const collect = (ep: Endpoint) => {
      allEndpoints.push(ep);
      for (const child of ep.parts) {
        collect(child);
      }
    };
    for (const ep of this.topLevelEndpoints()) {
      collect(ep);
    }

    let syncedCount = 0;
    let skippedCount = 0;

    for (const endpoint of allEndpoints) {
      try {
        if (!endpoint.behaviors.has(HomeAssistantEntityBehavior)) {
          continue;
        }

        const behavior = endpoint.stateOf(HomeAssistantEntityBehavior);
        const currentEntity = behavior.entity;

        if (currentEntity?.state) {
          const entityId = currentEntity.entity_id;
          // Compare only meaningful fields, ignore volatile HA metadata
          // (last_changed, last_updated, context) to avoid unnecessary MRP traffic.
          const stateJson = JSON.stringify({
            s: currentEntity.state.state,
            a: currentEntity.state.attributes,
          });
          const lastJson = this.lastSyncedStates.get(entityId);

          if (stateJson !== lastJson) {
            // State has changed since last sync, push update
            await updateEntityState(endpoint, { ...currentEntity.state });
            this.lastSyncedStates.set(entityId, stateJson);
            syncedCount++;
          } else {
            skippedCount++;
          }
        }
      } catch (e) {
        this.log.debug(`Force sync: Skipped endpoint due to error:`, e);
      }
    }

    if (syncedCount > 0) {
      this.log.info(
        `Force sync: Pushed ${syncedCount} changed device(s), skipped ${skippedCount} unchanged`,
      );
    }

    return syncedCount;
  }

  async delete(): Promise<void> {
    await this.server.delete();
  }
}
