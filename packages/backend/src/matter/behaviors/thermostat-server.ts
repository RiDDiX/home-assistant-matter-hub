import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { ThermostatServer as Base } from "@matter/main/behaviors";
import { Thermostat } from "@matter/main/clusters";

const logger = Logger.get("ThermostatServer");

import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { Temperature } from "../../utils/converters/temperature.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import SystemMode = Thermostat.SystemMode;
import RunningMode = Thermostat.ThermostatRunningMode;

import type { ActionContext } from "@matter/main";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";

// NOTE: AutoMode feature intentionally NOT included.
// Matter.js's internal #handleSystemModeChange reactor tries to write thermostatRunningMode
// in post-commit without asLocalActor, causing "Permission denied: Value is read-only" errors.
// By not including AutoMode, thermostatRunningMode is undefined and the internal reactor skips
// the problematic write. We still support Auto systemMode - just without the runningMode attribute.
// See: https://github.com/matter-js/matter.js/issues/3105
const FeaturedBase = Base.with("Heating", "Cooling");

export interface ThermostatRunningState {
  heat: boolean;
  cool: boolean;
  fan: boolean;
  heatStage2: false;
  coolStage2: false;
  fanStage2: false;
  fanStage3: false;
}

export interface ThermostatServerConfig {
  supportsTemperatureRange: ValueGetter<boolean>;
  getMinTemperature: ValueGetter<Temperature | undefined>;
  getMaxTemperature: ValueGetter<Temperature | undefined>;
  getCurrentTemperature: ValueGetter<Temperature | undefined>;
  getTargetHeatingTemperature: ValueGetter<Temperature | undefined>;
  getTargetCoolingTemperature: ValueGetter<Temperature | undefined>;

  getSystemMode: ValueGetter<SystemMode>;
  getRunningMode: ValueGetter<RunningMode>;

  setSystemMode: ValueSetter<SystemMode>;
  setTargetTemperature: ValueSetter<Temperature>;
  setTargetTemperatureRange: ValueSetter<{
    low: Temperature;
    high: Temperature;
  }>;
}

export class ThermostatServerBase extends FeaturedBase {
  declare state: ThermostatServerBase.State;

  override async initialize() {
    // CRITICAL: Set controlSequenceOfOperation BEFORE super.initialize() runs
    // because the value depends on which features are enabled, and Matter.js
    // validates conformance during initialization. Setting a wrong default in
    // the factory function would break single-mode thermostats (heat-only or cool-only).
    this.state.controlSequenceOfOperation =
      this.features.cooling && this.features.heating
        ? Thermostat.ControlSequenceOfOperation.CoolingAndHeating
        : this.features.cooling
          ? Thermostat.ControlSequenceOfOperation.CoolingOnly
          : Thermostat.ControlSequenceOfOperation.HeatingOnly;

    await super.initialize();

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);

    this.reactTo(this.events.systemMode$Changed, this.systemModeChanged);
    // Use $Changing (pre-commit) for setpoint changes to avoid access control issues
    // The $Changed event fires in post-commit where we lose write permissions
    if (this.features.cooling) {
      this.reactTo(
        this.events.occupiedCoolingSetpoint$Changing,
        this.coolingSetpointChanging,
      );
    }
    if (this.features.heating) {
      this.reactTo(
        this.events.occupiedHeatingSetpoint$Changing,
        this.heatingSetpointChanging,
      );
    }
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state) {
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const config = this.state.config;

    // When unavailable, keep last known values but report offline via BasicInformation.reachable
    // Only update temperatures if entity is available to prevent null/invalid values
    const isAvailable = homeAssistant.isAvailable;

    const minSetpointLimit = isAvailable
      ? config.getMinTemperature(entity.state, this.agent)?.celsius(true)
      : (this.state.minHeatSetpointLimit ?? this.state.minCoolSetpointLimit);
    const maxSetpointLimit = isAvailable
      ? config.getMaxTemperature(entity.state, this.agent)?.celsius(true)
      : (this.state.maxHeatSetpointLimit ?? this.state.maxCoolSetpointLimit);
    const localTemperature = isAvailable
      ? config.getCurrentTemperature(entity.state, this.agent)?.celsius(true)
      : this.state.localTemperature;
    const targetHeatingTemperature = isAvailable
      ? (config
          .getTargetHeatingTemperature(entity.state, this.agent)
          ?.celsius(true) ?? this.state.occupiedHeatingSetpoint)
      : this.state.occupiedHeatingSetpoint;
    const targetCoolingTemperature = isAvailable
      ? (config
          .getTargetCoolingTemperature(entity.state, this.agent)
          ?.celsius(true) ?? this.state.occupiedCoolingSetpoint)
      : this.state.occupiedCoolingSetpoint;

    const systemMode = isAvailable
      ? this.getSystemMode(entity)
      : (this.state.systemMode ?? Thermostat.SystemMode.Off);
    const runningMode = isAvailable
      ? config.getRunningMode(entity.state, this.agent)
      : Thermostat.ThermostatRunningMode.Off;

    // Temperature limit handling based on Matterbridge approach:
    // - For SINGLE-MODE (heat-only or cool-only): Use HA's actual min/max limits directly
    // - For DUAL-MODE (heat + cool): Use wide limits (like Matterbridge: 0-50°C) to avoid
    //   Matter.js deadband constraint issues. HA will validate actual values.
    //
    // This ensures Apple Home shows the correct temperature range for single-mode thermostats
    // while still working correctly for dual-mode thermostats.

    let minHeatLimit: number | undefined;
    let minCoolLimit: number | undefined;
    let maxHeatLimit: number | undefined;
    let maxCoolLimit: number | undefined;

    if (this.features.heating && this.features.cooling) {
      // DUAL-MODE: Use wide limits like Matterbridge (0-50°C = 0-5000 in 0.01°C units)
      // This avoids Matter.js deadband constraints and lets HA do the validation
      const WIDE_MIN = 0; // 0°C
      const WIDE_MAX = 5000; // 50°C

      minHeatLimit = WIDE_MIN;
      maxHeatLimit = WIDE_MAX;
      minCoolLimit = WIDE_MIN;
      maxCoolLimit = WIDE_MAX;
    } else if (this.features.heating && !this.features.cooling) {
      // HEAT-ONLY: Use HA's actual limits directly
      minHeatLimit = minSetpointLimit;
      maxHeatLimit = maxSetpointLimit;
    } else if (this.features.cooling && !this.features.heating) {
      // COOL-ONLY: Use HA's actual limits directly
      minCoolLimit = minSetpointLimit;
      maxCoolLimit = maxSetpointLimit;
    }

    // For single-mode, use HA limits for clamping; for dual-mode use wide limits
    const effectiveMinHeatLimit = minHeatLimit;
    const effectiveMaxHeatLimit = maxHeatLimit;
    const effectiveMinCoolLimit = minCoolLimit;
    const effectiveMaxCoolLimit = maxCoolLimit;

    // Clamp setpoints to be within the calculated limits to prevent Matter.js validation errors
    // This handles cases where HA reports setpoints outside the valid range
    const clampedHeatingSetpoint = this.clampSetpoint(
      targetHeatingTemperature,
      effectiveMinHeatLimit,
      effectiveMaxHeatLimit,
      "heat",
    );
    const clampedCoolingSetpoint = this.clampSetpoint(
      targetCoolingTemperature,
      effectiveMinCoolLimit,
      effectiveMaxCoolLimit,
      "cool",
    );

    applyPatchState(this.state, {
      localTemperature: localTemperature,
      systemMode: systemMode,
      thermostatRunningState: this.getRunningState(systemMode, runningMode),
      ...(this.features.heating
        ? {
            occupiedHeatingSetpoint: clampedHeatingSetpoint,
            minHeatSetpointLimit: minHeatLimit,
            maxHeatSetpointLimit: maxHeatLimit,
            absMinHeatSetpointLimit: minHeatLimit,
            absMaxHeatSetpointLimit: maxHeatLimit,
          }
        : {}),
      ...(this.features.cooling
        ? {
            occupiedCoolingSetpoint: clampedCoolingSetpoint,
            minCoolSetpointLimit: minCoolLimit,
            maxCoolSetpointLimit: maxCoolLimit,
            absMinCoolSetpointLimit: minCoolLimit,
            absMaxCoolSetpointLimit: maxCoolLimit,
          }
        : {}),
    });
  }

  override setpointRaiseLower(request: Thermostat.SetpointRaiseLowerRequest) {
    const config = this.state.config;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const state = homeAssistant.entity.state;

    let cool = config.getTargetCoolingTemperature(state, this.agent);
    let heat = config.getTargetHeatingTemperature(state, this.agent);

    if (!heat && !cool) {
      return;
    }
    heat = (heat ?? cool)!;
    cool = (cool ?? heat)!;

    const adjustedCool =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Heat
        ? cool.plus(request.amount / 1000, "°C")
        : cool;
    const adjustedHeat =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Cool
        ? heat.plus(request.amount / 1000, "°C")
        : heat;
    this.setTemperature(adjustedHeat, adjustedCool, request.mode);
  }

  /**
   * Pre-commit handler for heating setpoint changes.
   * Using $Changing instead of $Changed to ensure we have write permissions
   * when calling the Home Assistant action.
   */
  private heatingSetpointChanging(
    value: number,
    _oldValue: number,
    context?: ActionContext,
  ) {
    logger.debug(
      `heatingSetpointChanging: value=${value}, oldValue=${_oldValue}, isOffline=${transactionIsOffline(context)}`,
    );
    if (transactionIsOffline(context)) {
      logger.debug(
        "heatingSetpointChanging: skipping - transaction is offline",
      );
      return;
    }
    const next = Temperature.celsius(value / 100);
    if (!next) {
      logger.debug("heatingSetpointChanging: skipping - invalid temperature");
      return;
    }
    // Use asLocalActor to avoid access control issues when accessing HomeAssistantEntityBehavior
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const config = this.state.config;
      const supportsRange = config.supportsTemperatureRange(
        homeAssistant.entity.state,
        this.agent,
      );
      const currentMode = this.state.systemMode;
      logger.debug(
        `heatingSetpointChanging: supportsRange=${supportsRange}, systemMode=${currentMode}, features.heating=${this.features.heating}, features.cooling=${this.features.cooling}`,
      );

      // For single-temperature thermostats, only update HA when heating setpoint changes
      // if we're in heating mode (or auto/heat_cool). This prevents Apple Home's deadband
      // enforcement from sending the wrong temperature when both setpoints are updated.
      if (!supportsRange) {
        const isHeatingMode =
          currentMode === Thermostat.SystemMode.Heat ||
          currentMode === Thermostat.SystemMode.EmergencyHeat ||
          currentMode === Thermostat.SystemMode.Auto;
        if (!isHeatingMode) {
          logger.debug(
            `heatingSetpointChanging: skipping - not in heating mode (mode=${currentMode})`,
          );
          return; // Let coolingSetpointChanging handle this
        }
      }

      const coolingSetpoint = this.state.occupiedCoolingSetpoint;
      logger.debug(
        `heatingSetpointChanging: calling setTemperature with heat=${next.celsius(true)}, cool=${coolingSetpoint}`,
      );
      this.setTemperature(
        next,
        Temperature.celsius(coolingSetpoint / 100)!,
        Thermostat.SetpointRaiseLowerMode.Heat,
      );
    });
  }

  /**
   * Pre-commit handler for cooling setpoint changes.
   * Using $Changing instead of $Changed to ensure we have write permissions
   * when calling the Home Assistant action.
   */
  private coolingSetpointChanging(
    value: number,
    _oldValue: number,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    const next = Temperature.celsius(value / 100);
    if (!next) {
      return;
    }
    // Use asLocalActor to avoid access control issues when accessing HomeAssistantEntityBehavior
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const config = this.state.config;
      const supportsRange = config.supportsTemperatureRange(
        homeAssistant.entity.state,
        this.agent,
      );

      // For single-temperature thermostats, only update HA when cooling setpoint changes
      // if we're in cooling mode. This prevents Apple Home's deadband enforcement from
      // sending the wrong temperature when both setpoints are updated.
      if (!supportsRange) {
        const currentMode = this.state.systemMode;
        const isCoolingMode =
          currentMode === Thermostat.SystemMode.Cool ||
          currentMode === Thermostat.SystemMode.Precooling;
        if (!isCoolingMode) {
          return; // Let heatingSetpointChanging handle this
        }
      }

      const heatingSetpoint = this.state.occupiedHeatingSetpoint;
      this.setTemperature(
        Temperature.celsius(heatingSetpoint / 100)!,
        next,
        Thermostat.SetpointRaiseLowerMode.Cool,
      );
    });
  }

  private setTemperature(
    low: Temperature,
    high: Temperature,
    mode: Thermostat.SetpointRaiseLowerMode,
  ) {
    const config = this.state.config;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);

    const supportsTemperatureRange = config.supportsTemperatureRange(
      homeAssistant.entity.state,
      this.agent,
    );

    let action: HomeAssistantAction;
    if (supportsTemperatureRange) {
      action = config.setTargetTemperatureRange({ low, high }, this.agent);
    } else {
      const both = mode === Thermostat.SetpointRaiseLowerMode.Heat ? low : high;
      action = config.setTargetTemperature(both, this.agent);
    }
    homeAssistant.callAction(action);
  }

  private systemModeChanged(
    systemMode: Thermostat.SystemMode,
    _oldValue: Thermostat.SystemMode,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    // Use asLocalActor to avoid access control issues when accessing HomeAssistantEntityBehavior
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const action = this.state.config.setSystemMode(systemMode, this.agent);
      homeAssistant.callAction(action);
    });
  }

  private getSystemMode(entity: HomeAssistantEntityInformation) {
    let systemMode = this.state.config.getSystemMode(entity.state, this.agent);
    // Without AutoMode feature, map Auto to Heat or Cool based on available features
    if (systemMode === Thermostat.SystemMode.Auto) {
      systemMode = this.features.heating
        ? SystemMode.Heat
        : this.features.cooling
          ? SystemMode.Cool
          : SystemMode.Off;
    }
    return systemMode;
  }

  private getRunningState(
    systemMode: SystemMode,
    runningMode: RunningMode,
  ): ThermostatRunningState {
    const allOff: ThermostatRunningState = {
      cool: false,
      fan: false,
      heat: false,
      heatStage2: false,
      coolStage2: false,
      fanStage2: false,
      fanStage3: false,
    };
    const heat = { ...allOff, heat: true };
    const cool = { ...allOff, cool: true };
    const dry = { ...allOff, heat: true, fan: true };
    const fanOnly = { ...allOff, fan: true };
    switch (systemMode) {
      case SystemMode.Heat:
      case SystemMode.EmergencyHeat:
        return heat;
      case SystemMode.Cool:
      case SystemMode.Precooling:
        return cool;
      case SystemMode.Dry:
        return dry;
      case SystemMode.FanOnly:
        return fanOnly;
      case SystemMode.Off:
      case SystemMode.Sleep:
        return allOff;
      case SystemMode.Auto:
        switch (runningMode) {
          case RunningMode.Heat:
            return heat;
          case RunningMode.Cool:
            return cool;
          case RunningMode.Off:
            return allOff;
        }
    }
  }

  private clampSetpoint(
    value: number | undefined,
    min: number | undefined,
    max: number | undefined,
    _type: "heat" | "cool",
  ): number | undefined {
    // If no limits defined, return value as-is
    if (min == null && max == null) {
      return value;
    }

    // If value is undefined, use the minimum limit as default
    // This prevents NaN issues when HA doesn't provide a setpoint
    if (value == null) {
      return min;
    }

    // Clamp value to be within limits
    let clamped = value;
    if (min != null && clamped < min) {
      clamped = min;
    }
    if (max != null && clamped > max) {
      clamped = max;
    }

    return clamped;
  }
}

export namespace ThermostatServerBase {
  export class State extends FeaturedBase.State {
    config!: ThermostatServerConfig;
  }
}

export function ThermostatServer(config: ThermostatServerConfig) {
  // Provide default values for attributes to prevent conformance errors.
  // NOTE: controlSequenceOfOperation is NOT set here because its valid values
  // depend on which features (Heating, Cooling) are enabled. It MUST be set
  // in initialize() BEFORE super.initialize() runs.
  //
  // Using wide limits (0-50°C) like Matterbridge to avoid Matter.js deadband constraints.
  // Actual limits will be set in update() based on features and HA values.
  return ThermostatServerBase.set({
    config,
    // Provide reasonable defaults for setpoints to prevent undefined->NaN issues
    // These will be overwritten with actual HA values during initialize()
    localTemperature: 2100, // 21°C - reasonable room temperature default
    occupiedHeatingSetpoint: 2000, // 20°C in 0.01°C units
    occupiedCoolingSetpoint: 2400, // 24°C in 0.01°C units
    // Wide limits like Matterbridge (0-50°C) - actual limits set in update()
    minHeatSetpointLimit: 0, // 0°C
    maxHeatSetpointLimit: 5000, // 50°C
    minCoolSetpointLimit: 0, // 0°C
    maxCoolSetpointLimit: 5000, // 50°C
    // Absolute limits - also wide
    absMinHeatSetpointLimit: 0,
    absMaxHeatSetpointLimit: 5000,
    absMinCoolSetpointLimit: 0,
    absMaxCoolSetpointLimit: 5000,
  });
}
