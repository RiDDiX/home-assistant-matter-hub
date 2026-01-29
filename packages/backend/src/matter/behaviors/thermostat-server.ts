import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { ThermostatServer as Base } from "@matter/main/behaviors";
import { Thermostat } from "@matter/main/clusters";
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

    // IMPORTANT: Even without AutoMode feature, Matter.js still enforces internal constraints:
    // minHeatSetpointLimit <= minCoolSetpointLimit - minSetpointDeadBand (default 200 = 2°C)
    // maxHeatSetpointLimit <= maxCoolSetpointLimit - minSetpointDeadBand
    // We must ensure our limits satisfy this constraint to prevent initialization errors.
    // Using 250 (2.5°C) to have some margin over Matter.js default of 200 (2.0°C)
    const INTERNAL_DEADBAND = 250; // 2.5°C in 0.01°C units - safe margin over Matter.js default 2.0°C

    // When both heating and cooling are enabled, we need to ensure:
    // 1. minCoolSetpointLimit >= minHeatSetpointLimit + INTERNAL_DEADBAND
    // 2. maxCoolSetpointLimit >= maxHeatSetpointLimit + INTERNAL_DEADBAND
    //
    // STRATEGY: Expand the heat limits (lower min, keep max) and cool limits (keep min, raise max)
    // rather than restricting the user's range. This allows the full HA range for both setpoints
    // while satisfying Matter.js constraints. HA will validate the actual values when actions are called.
    let minHeatLimit = minSetpointLimit;
    let minCoolLimit = minSetpointLimit;
    let maxHeatLimit = maxSetpointLimit;
    let maxCoolLimit = maxSetpointLimit;

    if (this.features.heating && this.features.cooling) {
      // To satisfy: minHeat <= minCool - deadband
      // We lower minHeat instead of raising minCool, so user can still set cool to HA's min_temp
      const requiredMinHeat = (minSetpointLimit ?? 700) - INTERNAL_DEADBAND;
      minHeatLimit = Math.max(requiredMinHeat, 700); // Don't go below 7°C absolute minimum
      minCoolLimit = minSetpointLimit; // Keep cool min at HA's actual min_temp

      // To satisfy: maxHeat <= maxCool - deadband
      // Strategy: Try to raise maxCool first, but if that exceeds 35°C, we must also clamp maxHeat
      const MATTER_MAX_COOL_ABSOLUTE = 3500; // 35°C - Matter.js absolute maximum for cooling
      const MATTER_MIN_DEADBAND = 200; // 2°C - Matter.js minimum deadband

      // Calculate what maxCool would need to be to support the full heat range
      const requiredMaxCool = (maxSetpointLimit ?? 3000) + INTERNAL_DEADBAND;

      if (requiredMaxCool <= MATTER_MAX_COOL_ABSOLUTE) {
        // We can accommodate the full heat range by raising maxCool
        maxHeatLimit = maxSetpointLimit;
        maxCoolLimit = requiredMaxCool;
      } else {
        // maxCool would exceed 35°C, so we must clamp maxHeat as well
        maxCoolLimit = MATTER_MAX_COOL_ABSOLUTE;
        // maxHeat must be <= maxCool - deadband = 3500 - 200 = 3300
        const maxAllowedHeat = MATTER_MAX_COOL_ABSOLUTE - MATTER_MIN_DEADBAND;
        maxHeatLimit = Math.min(maxSetpointLimit ?? 3000, maxAllowedHeat);
      }
    } else if (this.features.heating && !this.features.cooling) {
      // Heating-only: Matter.js still enforces maxHeat <= maxCool - deadband internally
      // Even without Cooling feature, the default maxCoolSetpointLimit is 3500 (35°C)
      // We must clamp maxHeatSetpointLimit to satisfy: maxHeat <= 3500 - 200 = 3300
      const MATTER_MAX_COOL_DEFAULT = 3500;
      const MATTER_MIN_DEADBAND = 200;
      const maxAllowedHeat = MATTER_MAX_COOL_DEFAULT - MATTER_MIN_DEADBAND; // 3300 = 33°C
      maxHeatLimit = Math.min(maxSetpointLimit ?? 3000, maxAllowedHeat);
    }

    // Calculate actual limits for clamping setpoints
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
    if (transactionIsOffline(context)) {
      return;
    }
    const next = Temperature.celsius(value / 100);
    if (!next) {
      return;
    }
    // Use asLocalActor to avoid access control issues when accessing HomeAssistantEntityBehavior
    this.agent.asLocalActor(() => {
      const coolingSetpoint = this.state.occupiedCoolingSetpoint;
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
  // CRITICAL: These defaults must satisfy Matter.js constraints:
  // - minHeatSetpointLimit <= minCoolSetpointLimit - minSetpointDeadBand (default 200)
  // - maxHeatSetpointLimit <= maxCoolSetpointLimit - minSetpointDeadBand (default 200)
  // Without AutoMode, we can't set minSetpointDeadBand, so we must ensure limits satisfy
  // the constraint with the default 200 (2°C) deadband.
  return ThermostatServerBase.set({
    config,
    // Provide reasonable defaults for setpoints to prevent undefined->NaN issues
    // These will be overwritten with actual HA values during initialize()
    localTemperature: 2100, // 21°C - reasonable room temperature default
    occupiedHeatingSetpoint: 2000, // 20°C in 0.01°C units
    occupiedCoolingSetpoint: 2400, // 24°C in 0.01°C units
    // Limits must satisfy: minHeat <= minCool - 250 and maxHeat <= maxCool - 250
    minHeatSetpointLimit: 700, // 7°C
    maxHeatSetpointLimit: 2950, // 29.5°C (must be <= maxCool - 250)
    minCoolSetpointLimit: 950, // 9.5°C (must be >= minHeat + 250)
    maxCoolSetpointLimit: 3200, // 32°C
    // Absolute limits
    absMinHeatSetpointLimit: 700,
    absMaxHeatSetpointLimit: 3000,
    absMinCoolSetpointLimit: 700,
    absMaxCoolSetpointLimit: 3200,
  });
}
