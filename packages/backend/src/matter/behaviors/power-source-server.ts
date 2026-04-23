import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { PowerSourceServer as Base } from "@matter/main/behaviors";
import { PowerSource } from "@matter/main/clusters";
import { EntityStateProvider } from "../../services/bridges/entity-state-provider.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter } from "./utils/cluster-config.js";

const logger = Logger.get("PowerSourceServer");

export interface PowerSourceConfig {
  /**
   * Get battery percentage (0-100) from entity state
   */
  getBatteryPercent: ValueGetter<number | null>;
  /**
   * Get charging state from entity state
   */
  isCharging?: ValueGetter<boolean>;
}

const FeaturedBase = Base.with("Battery", "Rechargeable");

// biome-ignore lint/correctness/noUnusedVariables: Used by the function below
class PowerSourceServerBase extends FeaturedBase {
  declare state: PowerSourceServerBase.State;

  override async initialize() {
    await super.initialize();

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;

    // Set endpointList to include this endpoint - required for controllers to
    // associate the power source with the device. Without this, some controllers
    // (like Google Home) may not display the battery level.
    const endpointNumber = this.endpoint.number;
    if (endpointNumber != null) {
      applyPatchState(this.state, {
        endpointList: [endpointNumber],
      });
      logger.debug(
        `[${entityId}] PowerSource initialized with endpointList=[${endpointNumber}]`,
      );
    } else {
      logger.warn(
        `[${entityId}] PowerSource endpoint number is null during initialize - endpointList will be empty!`,
      );
    }

    // Log battery entity mapping for debugging
    const batteryEntity = homeAssistant.state.mapping?.batteryEntity;
    if (batteryEntity) {
      logger.debug(
        `[${entityId}] PowerSource using mapped battery entity: ${batteryEntity}`,
      );
    }

    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const config = this.state.config;
    const batteryPercent = this.getBatteryPercent(config, entity.state);
    const isCharging = this.getIsCharging(config, entity.state);

    // batPercentRemaining is in half-percent units (0-200)
    const batPercentRemaining =
      batteryPercent != null ? Math.round(batteryPercent * 2) : null;

    // Determine charge level based on percentage
    let batChargeLevel = PowerSource.BatChargeLevel.Ok;
    if (batteryPercent != null) {
      if (batteryPercent <= 10) {
        batChargeLevel = PowerSource.BatChargeLevel.Critical;
      } else if (batteryPercent <= 20) {
        batChargeLevel = PowerSource.BatChargeLevel.Warning;
      }
    }

    // Determine charge state
    let batChargeState = PowerSource.BatChargeState.Unknown;
    if (isCharging === true) {
      batChargeState =
        batteryPercent != null && batteryPercent >= 100
          ? PowerSource.BatChargeState.IsAtFullCharge
          : PowerSource.BatChargeState.IsCharging;
    } else if (isCharging === false) {
      batChargeState = PowerSource.BatChargeState.IsNotCharging;
    }

    applyPatchState(this.state, {
      status: PowerSource.PowerSourceStatus.Active,
      batPercentRemaining,
      batChargeLevel,
      batChargeState,
    });
  }

  private getBatteryPercent(
    config: PowerSourceConfig,
    entity: HomeAssistantEntityState,
  ): number | null {
    const percent = config.getBatteryPercent(entity, this.agent);
    if (percent == null) {
      return null;
    }
    // Clamp to 0-100
    return Math.max(0, Math.min(100, percent));
  }

  private getIsCharging(
    config: PowerSourceConfig,
    entity: HomeAssistantEntityState,
  ): boolean | undefined {
    if (!config.isCharging) {
      return undefined;
    }
    return config.isCharging(entity, this.agent);
  }
}

namespace PowerSourceServerBase {
  export class State extends FeaturedBase.State {
    config!: PowerSourceConfig;
  }
}

export function PowerSourceServer(config: PowerSourceConfig) {
  return PowerSourceServerBase.set({
    config,
    // Set order to ensure PowerSource is on endpoint 0 or appropriate position
    order: PowerSource.Cluster.id,
  });
}

/**
 * Default battery config shared by all domain endpoints.
 * Checks for a mapped battery entity first (via EntityStateProvider),
 * then falls back to the entity's own battery/battery_level attribute.
 */
export const defaultBatteryConfig: PowerSourceConfig = {
  getBatteryPercent: (entity, agent) => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const batteryEntity = homeAssistant.state.mapping?.batteryEntity;
    if (batteryEntity) {
      const stateProvider = agent.env.get(EntityStateProvider);
      const battery = stateProvider.getBatteryPercent(batteryEntity);
      if (battery != null) {
        return Math.max(0, Math.min(100, battery));
      }
    }

    const attrs = entity.attributes as {
      battery?: number;
      battery_level?: number;
    };
    const level = attrs.battery_level ?? attrs.battery;
    if (level == null || Number.isNaN(Number(level))) {
      return null;
    }
    return Number(level);
  },
};

/**
 * Pre-configured PowerSourceServer using the default battery config.
 * Use this instead of duplicating the battery getter in every domain endpoint.
 */
export const DefaultPowerSourceServer = PowerSourceServer(defaultBatteryConfig);
