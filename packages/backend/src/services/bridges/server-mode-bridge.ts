import {
  BridgeStatus,
  type ExposedDeviceType,
  type UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import { BasicInformationServer } from "@matter/main/behaviors";
import { CommissioningServer } from "@matter/main/node";
import { SessionManager } from "@matter/main/protocol";
import type { LoggerService } from "../../core/app/logger.js";
import type { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { updateEntityState } from "../../matter/endpoints/update-entity-state.js";
import {
  applyLegacySpecSessionParameters,
  specVersionValues,
} from "../../matter/legacy-spec-version.js";
import { applyTcpFlagBeforeStart } from "../../plugins/builtin/camera/camera-tcp-requirement.js";
import { ensureCommissioningConfig } from "../../utils/ensure-commissioning-config.js";
import { logMemoryUsage } from "../../utils/log-memory.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import type {
  BridgeDataProvider,
  BridgeServerStatus,
} from "./bridge-data-provider.js";
import type { ServerModeEndpointManager } from "./server-mode-endpoint-manager.js";
import { DEFAULT_SESSION_MAX_AGE_HOURS } from "./session-rotation.js";
import { SessionSupervisor } from "./session-supervisor.js";

// Auto Force Sync interval in milliseconds (90 seconds).
// When autoForceSync is enabled, this pushes changed entity states to
// Matter controllers. matter.js handles subscription keepalive internally
// via empty DataReports every ~sendInterval.
const AUTO_FORCE_SYNC_INTERVAL_MS = 90_000;

export function makeWarmStartState<T extends { last_updated?: string }>(
  state: T,
  now = new Date().toISOString(),
): T {
  return { ...state, last_updated: now };
}

/**
 * ServerModeBridge exposes a single device as a standalone Matter device.
 * This is required for Apple Home to properly support Siri voice commands
 * for Robot Vacuums (RVC) and similar device types.
 */
export class ServerModeBridge {
  private readonly log: Logger;
  private readonly sessions: SessionSupervisor;

  private status: BridgeServerStatus = {
    code: BridgeStatus.Stopped,
    reason: undefined,
  };

  // Called whenever the bridge status changes. Set by BridgeService to
  // broadcast updates via WebSocket so the frontend sees every transition.
  public onStatusChange?: () => void;

  private autoForceSyncTimer: ReturnType<typeof setInterval> | null = null;
  private warmStartTimer: ReturnType<typeof setTimeout> | null = null;

  // Tracks the last synced state JSON per entity to avoid pushing unchanged states.
  private readonly lastSyncedStates = new Map<string, string>();

  get id(): string {
    return this.dataProvider.id;
  }

  get data() {
    return this.dataProvider.withMetadata(
      this.status,
      this.server,
      this.endpointManager.devices.length,
      this.endpointManager.failedEntities,
      this.getExposedDeviceTypes(),
    );
  }

  /**
   * The entity id and numeric Matter device type of every exposed device, so a
   * controller-support warning can be raised per bridge (#365 class). Server
   * mode is flat, but walk parts anyway to stay correct.
   */
  getExposedDeviceTypes(): ExposedDeviceType[] {
    const out: ExposedDeviceType[] = [];
    const collect = (
      ep: {
        type?: { deviceType?: number };
        entityId?: string;
        parts: Iterable<unknown>;
      },
      inheritedEntityId?: string,
    ) => {
      const entityId = ep.entityId ?? inheritedEntityId;
      const deviceTypeId = ep.type?.deviceType;
      if (typeof deviceTypeId === "number" && entityId) {
        out.push({ entityId, deviceTypeId });
      }
      for (const child of ep.parts) {
        collect(child as typeof ep, entityId);
      }
    };
    for (const device of this.endpointManager.devices) {
      collect(device as unknown as Parameters<typeof collect>[0]);
    }
    return out;
  }

  getSessionInfo() {
    return this.sessions.getSessionInfo();
  }

  constructor(
    logger: LoggerService,
    private readonly dataProvider: BridgeDataProvider,
    private readonly endpointManager: ServerModeEndpointManager,
    readonly server: ServerModeServerNode,
  ) {
    this.log = logger.get(`ServerModeBridge / ${dataProvider.id}`);
    this.sessions = new SessionSupervisor(
      this.log,
      this.server,
      this.dataProvider,
      () => this.data,
      DEFAULT_SESSION_MAX_AGE_HOURS,
    );
  }

  async initialize(): Promise<void> {
    await this.server.construction.ready.then();
    await this.refreshDevices();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  async refreshDevices(): Promise<void> {
    await this.endpointManager.refreshDevices();
  }

  private setStatus(status: BridgeServerStatus) {
    this.status = status;
    this.onStatusChange?.();
  }

  async start(): Promise<void> {
    if (this.status.code === BridgeStatus.Running) {
      return;
    }
    this.lastSyncedStates.clear();
    try {
      this.setStatus({
        code: BridgeStatus.Starting,
        reason: "The server mode bridge is starting... Please wait.",
      });
      await this.refreshDevices();
      logMemoryUsage(this.log, "after refreshDevices (server mode)");
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
      this.setStatus({ code: BridgeStatus.Running });
      this.startAutoForceSyncIfEnabled();
      if (this.dataProvider.featureFlags?.autoForceSync) {
        this.forceSync().catch((e) => {
          this.log.warn("Startup force sync failed:", e);
        });
      }
      this.sessions.start();
      this.scheduleWarmStart();
      logMemoryUsage(this.log, "server mode bridge running");
      this.log.info("Server mode bridge started");
      diagnosticEventBus.emit("bridge_started", "Server mode bridge started", {
        bridgeId: this.id,
        bridgeName: this.dataProvider.name,
      });
    } catch (e) {
      const reason = "Failed to start server mode bridge due to error:";
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  async stop(
    code: BridgeStatus = BridgeStatus.Stopped,
    reason = "Manually stopped",
  ): Promise<void> {
    this.sessions.stop();
    this.cancelWarmStart();
    this.stopAutoForceSync();
    await this.sessions.closeActiveSessions();
    this.endpointManager.stopObserving();
    try {
      await this.server.cancel();
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (!errorMessage.includes("mutex-closed")) {
        this.log.warn("Error stopping server mode bridge:", e);
      }
    }
    this.setStatus({ code, reason });
    diagnosticEventBus.emit(
      "bridge_stopped",
      `Server mode bridge stopped: ${reason}`,
      {
        bridgeId: this.id,
        bridgeName: this.dataProvider.name,
      },
    );
  }

  async update(update: UpdateBridgeRequest): Promise<void> {
    try {
      this.dataProvider.update(update);
      await this.refreshDevices();
      // Re-evaluate auto force sync setting after config update
      if (this.status.code === BridgeStatus.Running) {
        this.startAutoForceSyncIfEnabled();
        // Re-read sessionMaxAgeHours so UI changes apply without restart (#287)
        this.sessions.reconfigure();
      }
    } catch (e) {
      const reason = "Failed to update server mode bridge due to error:";
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  async factoryReset(): Promise<void> {
    if (this.status.code !== BridgeStatus.Running) {
      return;
    }
    await this.server.factoryReset();
    this.setStatus({ code: BridgeStatus.Stopped });
    await this.start();
  }

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

  /**
   * Schedule a one-time state push shortly after bridge start.
   * This refreshes internal attribute versions so that controllers
   * reading attributes after session establishment get current data.
   */
  private scheduleWarmStart() {
    this.cancelWarmStart();
    this.warmStartTimer = setTimeout(() => {
      this.warmStartTimer = null;
      this.pushCurrentState().catch((e) => {
        this.log.debug("Warm-start state push failed:", e);
      });
    }, 15_000);
  }

  private cancelWarmStart() {
    if (this.warmStartTimer) {
      clearTimeout(this.warmStartTimer);
      this.warmStartTimer = null;
    }
  }

  /**
   * Push the current device state unconditionally.
   * Unlike forceSync, this ignores the autoForceSync flag and always pushes.
   */
  private async pushCurrentState(): Promise<void> {
    if (this.status.code !== BridgeStatus.Running) {
      return;
    }
    const devices = this.endpointManager.devices;
    if (devices.length === 0) {
      return;
    }
    const { HomeAssistantEntityBehavior } = await import(
      "../../matter/behaviors/home-assistant-entity-behavior.js"
    );
    let pushed = 0;
    for (const device of devices) {
      try {
        if (!device.behaviors.has(HomeAssistantEntityBehavior)) {
          continue;
        }
        const behavior = device.stateOf(HomeAssistantEntityBehavior);
        const currentEntity = behavior.entity;
        if (currentEntity?.state) {
          await updateEntityState(
            device,
            makeWarmStartState(currentEntity.state),
          );
          pushed++;
        }
      } catch (e) {
        this.log.debug("Warm-start: Failed to push state:", e);
      }
    }
    if (pushed > 0) {
      this.log.info(`Warm-start: Pushed initial state for ${pushed} devices`);
    }
  }

  async delete(): Promise<void> {
    await this.server.delete();
  }

  /**
   * Force sync the device state to all connected Matter controllers.
   * Only pushes state when the entity state has actually changed since
   * the last sync to avoid unnecessary MRP traffic.
   */
  async forceSync(): Promise<number> {
    if (this.status.code !== BridgeStatus.Running) {
      return 0;
    }

    if (!this.dataProvider.featureFlags?.autoForceSync) {
      return 0;
    }

    const devices = this.endpointManager.devices;
    if (devices.length === 0) {
      return 0;
    }

    // Import dynamically to avoid circular dependencies
    const { HomeAssistantEntityBehavior } = await import(
      "../../matter/behaviors/home-assistant-entity-behavior.js"
    );

    let synced = 0;
    for (const device of devices) {
      try {
        if (!device.behaviors.has(HomeAssistantEntityBehavior)) {
          continue;
        }

        const behavior = device.stateOf(HomeAssistantEntityBehavior);
        const currentEntity = behavior.entity;

        if (currentEntity?.state) {
          // Compare only meaningful fields, ignore volatile HA metadata
          // (last_changed, last_updated, context) to avoid unnecessary MRP traffic.
          const stateJson = JSON.stringify({
            s: currentEntity.state.state,
            a: currentEntity.state.attributes,
          });

          if (stateJson !== this.lastSyncedStates.get(device.entityId)) {
            // State has changed since last sync, push update
            await updateEntityState(device, { ...currentEntity.state });
            this.lastSyncedStates.set(device.entityId, stateJson);
            synced++;
          }
        }
      } catch (e) {
        this.log.debug("Force sync: Failed due to error:", e);
      }
    }

    if (synced > 0) {
      this.log.info(`Force sync: Pushed ${synced} changed devices`);
    }
    return synced;
  }
}
