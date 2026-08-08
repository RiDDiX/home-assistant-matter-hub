import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { HepaFilterMonitoringServer as Base } from "@matter/main/behaviors";
import { ResourceMonitoring } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter } from "./utils/cluster-config.js";

export interface HepaFilterMonitoringConfig {
  /**
   * Get the filter life remaining as a percentage (0-100).
   * Returns null if not available.
   */
  getFilterLifePercent: ValueGetter<number | null>;
}

// Base server with Condition and Warning features enabled
const FeaturedBase = Base.with("Condition", "Warning");

/**
 * HepaFilterMonitoring Cluster implementation for Air Purifiers.
 * Reports filter condition/life remaining to Matter controllers.
 *
 * The `condition` attribute represents the filter life remaining:
 * - 100 = new filter (100% life remaining)
 * - 0 = filter needs replacement (0% life remaining)
 *
 * The `changeIndication` attribute indicates if the filter should be replaced:
 * - Ok = filter is fine
 * - Warning = filter life low (< 20%)
 * - Critical = filter needs immediate replacement (< 5%)
 */
// biome-ignore lint/correctness/noUnusedVariables: Used by HepaFilterMonitoringServer function
class HepaFilterMonitoringServerBase extends FeaturedBase {
  declare state: HepaFilterMonitoringServerBase.State;

  override async initialize() {
    // Set initial state before super.initialize()
    this.state.condition = 100;
    this.state.degradationDirection =
      ResourceMonitoring.DegradationDirection.Down;
    this.state.changeIndication = ResourceMonitoring.ChangeIndication.Ok;

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const filterLife = this.getFilterLife(this.state.config, entity.state);

    if (filterLife !== null) {
      // Clamp to valid range 0-100
      const condition = Math.max(0, Math.min(100, Math.round(filterLife)));

      // Determine change indication based on filter life
      let changeIndication: ResourceMonitoring.ChangeIndication;
      if (condition <= 5) {
        changeIndication = ResourceMonitoring.ChangeIndication.Critical;
      } else if (condition <= 20) {
        changeIndication = ResourceMonitoring.ChangeIndication.Warning;
      } else {
        changeIndication = ResourceMonitoring.ChangeIndication.Ok;
      }

      applyPatchState(this.state, {
        condition,
        changeIndication,
        degradationDirection: ResourceMonitoring.DegradationDirection.Down,
      });
    }
  }

  private getFilterLife(
    config: HepaFilterMonitoringConfig,
    entity: HomeAssistantEntityState,
  ): number | null {
    return config.getFilterLifePercent(entity, this.agent);
  }
}

namespace HepaFilterMonitoringServerBase {
  export class State extends FeaturedBase.State {
    config!: HepaFilterMonitoringConfig;
  }
}

export function HepaFilterMonitoringServer(config: HepaFilterMonitoringConfig) {
  return HepaFilterMonitoringServerBase.set({ config });
}
