import {
  BridgeStatus,
  type ExposedDeviceType,
  type UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import type { Environment } from "@matter/general";
import type { Endpoint } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors";
import { CommissioningServer } from "@matter/main/node";
import { SessionManager } from "@matter/main/protocol";
import type { BetterLogger, LoggerService } from "../../core/app/logger.js";
import { BridgeServerNode } from "../../matter/endpoints/bridge-server-node.js";
import { updateEntityState } from "../../matter/endpoints/update-entity-state.js";
import {
  applyLegacySpecSessionParameters,
  specVersionValues,
} from "../../matter/legacy-spec-version.js";
import {
  applyTcpFlagBeforeStart,
  CAMERA_TCP_CONFIG,
  parseCameraList,
} from "../../plugins/builtin/camera/camera-tcp-requirement.js";
import type {
  PluginConfigSchema,
  PluginMetadata,
} from "../../plugins/types.js";
import { ensureCommissioningConfig } from "../../utils/ensure-commissioning-config.js";
import { isHeapUnderPressure, logMemoryUsage } from "../../utils/log-memory.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import type {
  BridgeDataProvider,
  BridgeServerStatus,
} from "./bridge-data-provider.js";
import type { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { EntityIsolationService } from "./entity-isolation-service.js";
import { SessionSupervisor } from "./session-supervisor.js";

// Auto Force Sync interval in milliseconds (90 seconds).
// When autoForceSync is enabled, this pushes changed entity states to
// Matter controllers. matter.js handles subscription keepalive internally
// via empty DataReports every ~sendInterval.
const AUTO_FORCE_SYNC_INTERVAL_MS = 90_000;

export class Bridge {
  private readonly log: BetterLogger;
  readonly server: BridgeServerNode;
  private readonly sessions: SessionSupervisor;

  private status: BridgeServerStatus = {
    code: BridgeStatus.Stopped,
    reason: undefined,
  };

  // Called whenever the bridge status changes. Set by BridgeService to
  // broadcast updates via WebSocket so the frontend sees every transition
  // (e.g. Stopped → Starting → Running).
  public onStatusChange?: () => void;

  private autoForceSyncTimer: ReturnType<typeof setInterval> | null = null;

  // Serialize concurrent lifecycle calls so auto-recovery and a manual
  // restartBridge can't race past each other's Starting/Stopping states.
  private startInFlight?: Promise<void>;
  private stopInFlight?: Promise<void>;

  // Tracks the last synced state JSON per entity to avoid pushing unchanged states.
  // Key: entity_id, Value: JSON.stringify of entity.state
  private lastSyncedStates = new Map<string, string>();

  get id() {
    return this.dataProvider.id;
  }

  get data() {
    return this.dataProvider.withMetadata(
      this.status,
      this.server,
      this.aggregator.parts.size,
      this.endpointManager.failedEntities,
      this.getExposedDeviceTypes(),
    );
  }

  get aggregator() {
    return this.endpointManager.root;
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
    for (const ep of this.aggregator.parts) {
      collect(ep);
    }
    return out;
  }

  getSessionInfo() {
    return this.sessions.getSessionInfo();
  }

  get pluginInfo() {
    return this.endpointManager.getPluginInfo();
  }

  async enablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.endpointManager.enablePlugin(pluginName);
  }

  async disablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.endpointManager.disablePlugin(pluginName);
  }

  resetPlugin(pluginName: string): void {
    this.endpointManager.resetPlugin(pluginName);
  }

  getPluginConfigSchema(pluginName: string): PluginConfigSchema | undefined {
    return this.endpointManager.getPluginConfigSchema(pluginName);
  }

  async updatePluginConfig(
    pluginName: string,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.endpointManager.updatePluginConfig(
      pluginName,
      config,
    );
    // only when the save actually landed, else tcp state drifts from storage
    if (result && pluginName === "camera") {
      await this.applyCameraTcp(config);
    }
    return result;
  }

  // #419: cameras need Matter over TCP because the WebRTC offer exceeds the UDP
  // message size. Match the bridge listener to the saved camera list. Changing
  // network config takes effect on (re)start, so bounce the bridge if running.
  private async applyCameraTcp(config: Record<string, unknown>): Promise<void> {
    const want =
      parseCameraList(config.cameras).length > 0 ||
      !!this.dataProvider.featureFlags?.enableMatterTcp;
    const have = !!this.server.state.network.tcp;
    if (want === have) {
      return;
    }
    this.log.info(
      want
        ? "cameras configured, enabling matter over tcp (#419)"
        : "no cameras left, disabling matter over tcp (#419)",
    );
    const running = this.status.code === BridgeStatus.Running;
    if (running) {
      await this.stop();
    }
    try {
      await this.server.set({
        network: { tcp: want ? CAMERA_TCP_CONFIG : undefined },
      });
    } catch (e) {
      this.log.warn(
        "Could not apply tcp live, restart matterhub to apply it:",
        e,
      );
    }
    if (running) {
      await this.start();
    }
  }

  constructor(
    env: Environment,
    logger: LoggerService,
    private readonly dataProvider: BridgeDataProvider,
    private readonly endpointManager: BridgeEndpointManager,
    private readonly serverOptions?: {
      tcp?: { incoming: boolean; outgoing: boolean };
    },
  ) {
    this.log = logger.get(`Bridge / ${dataProvider.id}`);
    this.server = new BridgeServerNode(
      env,
      this.dataProvider,
      this.endpointManager.root,
      this.serverOptions,
    );
    this.endpointManager.setTopologyChangeHandler(async (change) => {
      await this.server.act("plugin topology change", (agent) =>
        agent.get(BasicInformationServer).increaseConfigurationVersion(change),
      );
      this.log.debugCtx("Matter topology configuration version increased", {
        configurationVersion: this.server.stateOf(BasicInformationServer)
          .configurationVersion,
      });
    });
    // rotation is opt-in on an aggregator bridge, one controller session
    // holds many devices
    this.sessions = new SessionSupervisor(
      this.log,
      this.server,
      this.dataProvider,
      () => this.data,
      0,
    );
    const { basicInformation } = this.dataProvider;
    this.log.debugCtx("Root bridge BasicInformation configured", {
      vendorName: basicInformation.vendorName,
      productName: basicInformation.productName,
      productLabel: basicInformation.productLabel,
      hardwareVersion: basicInformation.hardwareVersion,
      hardwareVersionString: basicInformation.hardwareVersionString,
      softwareVersion: basicInformation.softwareVersion,
      softwareVersionString: basicInformation.softwareVersionString,
    });
  }

  async initialize(): Promise<void> {
    await this.server.construction.ready.then();
    await this.refreshDevices();
  }
  async dispose(): Promise<void> {
    await this.stop();
  }

  async refreshDevices() {
    await this.endpointManager.refreshDevices();
    // Prune stale entries from lastSyncedStates for entities that were removed
    const currentEntityIds = new Set(
      [...this.aggregator.parts].map(
        (p) => (p as { entityId?: string }).entityId,
      ),
    );
    for (const entityId of this.lastSyncedStates.keys()) {
      if (!currentEntityIds.has(entityId)) {
        this.lastSyncedStates.delete(entityId);
      }
    }
  }

  private setStatus(status: BridgeServerStatus) {
    this.status = status;
    this.onStatusChange?.();
  }

  async start() {
    if (this.status.code === BridgeStatus.Running) {
      return;
    }
    if (this.startInFlight) {
      return this.startInFlight;
    }
    this.startInFlight = this.runStart().finally(() => {
      this.startInFlight = undefined;
    });
    return this.startInFlight;
  }

  private async runStart() {
    this.lastSyncedStates.clear();
    // every start recreates the endpoints, so an isolation from a previous
    // run must not keep showing the entity as failed
    EntityIsolationService.clearIsolatedEntities(this.id);
    try {
      this.setStatus({
        code: BridgeStatus.Starting,
        reason: "The bridge is starting... Please wait.",
      });
      await this.refreshDevices();
      logMemoryUsage(
        this.log,
        `after refreshDevices (${this.aggregator.parts.size} endpoints)`,
      );
      this.endpointManager.startObserving();
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
      await this.server.start();
      await this.endpointManager.startPlugins();
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
      logMemoryUsage(this.log, "bridge running");
      diagnosticEventBus.emit("bridge_started", `Bridge started`, {
        bridgeId: this.id,
        bridgeName: this.dataProvider.name,
        details: { deviceCount: this.aggregator.parts.size },
      });
    } catch (e) {
      const reason = "Failed to start bridge due to error:";
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  async stop(
    code: BridgeStatus = BridgeStatus.Stopped,
    reason = "Manually stopped",
  ) {
    if (this.stopInFlight) {
      return this.stopInFlight;
    }
    this.stopInFlight = this.runStop(code, reason).finally(() => {
      this.stopInFlight = undefined;
    });
    return this.stopInFlight;
  }

  private async runStop(code: BridgeStatus, reason: string) {
    this.sessions.stop();
    this.stopAutoForceSync();
    await this.sessions.closeActiveSessions();
    await this.endpointManager.stopPlugins();
    this.endpointManager.stopObserving();
    try {
      await this.server.cancel();
    } catch (e) {
      // Ignore mutex-closed errors during shutdown - this is expected
      // when the environment is being disposed
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (!errorMessage.includes("mutex-closed")) {
        this.log.warn("Error stopping bridge server:", e);
      }
    }
    this.setStatus({ code, reason });
    diagnosticEventBus.emit("bridge_stopped", `Bridge stopped: ${reason}`, {
      bridgeId: this.id,
      bridgeName: this.dataProvider.name,
    });
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

  async update(update: UpdateBridgeRequest) {
    try {
      this.dataProvider.update(update);
      await this.refreshDevices();
      // Re-evaluate auto force sync and session rotation after config update
      if (this.status.code === BridgeStatus.Running) {
        this.startAutoForceSyncIfEnabled();
        this.sessions.reconfigure();
      }
    } catch (e) {
      const reason = "Failed to update bridge due to error:";
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  async factoryReset() {
    if (this.status.code !== BridgeStatus.Running) {
      return;
    }
    await this.server.factoryReset();
    this.setStatus({ code: BridgeStatus.Stopped });
    await this.start();
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
        "Force sync skipped: heap under pressure, reduce entities or raise NODE_OPTIONS=--max-old-space-size",
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
    for (const ep of this.aggregator.parts) {
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

  async delete() {
    await this.server.delete();
  }
}
