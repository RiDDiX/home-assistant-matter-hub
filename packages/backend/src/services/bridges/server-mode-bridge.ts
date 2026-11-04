import { BridgeStatus } from "@home-assistant-matter-hub/common";
import type { Endpoint } from "@matter/main";
import type { LoggerService } from "../../core/app/logger.js";
import type { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { updateEntityState } from "../../matter/endpoints/update-entity-state.js";
import { BridgeBase } from "./bridge-base.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import type { ServerModeEndpointManager } from "./server-mode-endpoint-manager.js";
import { DEFAULT_SESSION_MAX_AGE_HOURS } from "./session-rotation.js";

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
export class ServerModeBridge extends BridgeBase<
  ServerModeServerNode,
  ServerModeEndpointManager
> {
  private warmStartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    logger: LoggerService,
    dataProvider: BridgeDataProvider,
    endpointManager: ServerModeEndpointManager,
    server: ServerModeServerNode,
  ) {
    super(
      logger.get(`ServerModeBridge / ${dataProvider.id}`),
      dataProvider,
      endpointManager,
      server,
      DEFAULT_SESSION_MAX_AGE_HOURS,
    );
  }

  protected override get label() {
    return "Server mode bridge";
  }

  // Server mode is flat, composed shapes are skipped in standalone mode (#301)
  protected override topLevelEndpoints(): Endpoint[] {
    return this.endpointManager.devices;
  }

  protected override async onServerStarted(): Promise<void> {
    this.scheduleWarmStart();
  }

  protected override async runStop(
    code: BridgeStatus,
    reason: string,
  ): Promise<void> {
    this.cancelWarmStart();
    await super.runStop(code, reason);
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
}
