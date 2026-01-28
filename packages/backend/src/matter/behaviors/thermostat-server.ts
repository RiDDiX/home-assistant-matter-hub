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

const FeaturedBase = Base.with("Heating", "Cooling", "AutoMode");

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
    if (this.features.cooling) {
      this.reactTo(
        this.events.occupiedCoolingSetpoint$Changed,
        this.coolingSetpointChanged,
      );
    }
    if (this.features.heating) {
      this.reactTo(
        this.events.occupiedHeatingSetpoint$Changed,
        this.heatingSetpointChanged,
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

    // When autoMode is enabled AND currently in Auto mode, Matter spec requires:
    // - minHeatSetpointLimit <= minCoolSetpointLimit - minSetpointDeadBand
    // - maxHeatSetpointLimit <= maxCoolSetpointLimit - minSetpointDeadBand
    // minSetpointDeadBand: int8 (max 127), unit 0.1°C → 25 = 2.5°C
    // Temperature limits: int16, unit 0.01°C → offset 250 = 2.5°C
    // Only apply deadband when CURRENTLY in Auto mode, not just when feature is supported
    // This fixes the 2.5°C offset issue when user is in Heat/Cool only mode (#21)
    const isCurrentlyInAutoMode =
      this.features.autoMode && systemMode === SystemMode.Auto;
    const deadBandAttr = isCurrentlyInAutoMode ? 25 : 0;
    const deadBandOffset = isCurrentlyInAutoMode ? 250 : 0; // for limit calculations (0.01°C)
    const minCoolLimit =
      minSetpointLimit != null ? minSetpointLimit + deadBandOffset : undefined;
    const maxHeatLimit =
      maxSetpointLimit != null ? maxSetpointLimit - deadBandOffset : undefined;

    // Calculate actual limits for clamping setpoints
    const effectiveMinHeatLimit = minSetpointLimit;
    const effectiveMaxHeatLimit = maxHeatLimit ?? maxSetpointLimit;
    const effectiveMinCoolLimit = minCoolLimit ?? minSetpointLimit;
    const effectiveMaxCoolLimit = maxSetpointLimit;

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
      ...(this.features.autoMode
        ? {
            minSetpointDeadBand: deadBandAttr,
            thermostatRunningMode: runningMode,
          }
        : {}),
      ...(this.features.heating
        ? {
            occupiedHeatingSetpoint: clampedHeatingSetpoint,
            minHeatSetpointLimit: minSetpointLimit,
            maxHeatSetpointLimit: maxHeatLimit ?? maxSetpointLimit,
            absMinHeatSetpointLimit: minSetpointLimit,
            absMaxHeatSetpointLimit: maxHeatLimit ?? maxSetpointLimit,
          }
        : {}),
      ...(this.features.cooling
        ? {
            occupiedCoolingSetpoint: clampedCoolingSetpoint,
            minCoolSetpointLimit: minCoolLimit ?? minSetpointLimit,
            maxCoolSetpointLimit: maxSetpointLimit,
            absMinCoolSetpointLimit: minCoolLimit ?? minSetpointLimit,
            absMaxCoolSetpointLimit: maxSetpointLimit,
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

  private heatingSetpointChanged(
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
    // Use setImmediate to call HA action outside the transaction to avoid conflicts
    const coolingSetpoint = this.state.occupiedCoolingSetpoint;
    setImmediate(() => {
      this.setTemperature(
        next,
        Temperature.celsius(coolingSetpoint / 100)!,
        Thermostat.SetpointRaiseLowerMode.Heat,
      );
    });
  }

  private coolingSetpointChanged(
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
    // Use setImmediate to call HA action outside the transaction to avoid conflicts
    const heatingSetpoint = this.state.occupiedHeatingSetpoint;
    setImmediate(() => {
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
    // CRITICAL: Use setImmediate to call the HA action OUTSIDE the current transaction.
    // This ensures the action is called even if Matter.js's internal reactor
    // (#handleSystemModeChange) fails with a "Permission denied" error during post-commit.
    // Without this, Heat↔Cool mode changes from Apple Home would silently fail.
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.setSystemMode(systemMode, this.agent);
    setImmediate(() => {
      homeAssistant.callAction(action);
    });
  }

  private getSystemMode(entity: HomeAssistantEntityInformation) {
    let systemMode = this.state.config.getSystemMode(entity.state, this.agent);
    if (systemMode === Thermostat.SystemMode.Auto) {
      systemMode = this.features.autoMode
        ? SystemMode.Auto
        : this.features.heating
          ? SystemMode.Heat
          : this.features.cooling
            ? SystemMode.Cool
            : SystemMode.Sleep;
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
  // - minHeatSetpointLimit <= minCoolSetpointLimit - minSetpointDeadBand
  // - maxHeatSetpointLimit <= maxCoolSetpointLimit - minSetpointDeadBand
  // With minSetpointDeadBand=0, we just need minHeat <= minCool and maxHeat <= maxCool
  return ThermostatServerBase.set({
    config,
    // CRITICAL: Set deadband to 0 to prevent constraint validation failures
    // Matter.js default is 25 (2.5°C) which can cause limit constraint errors
    // when HA reports the same min/max for both heating and cooling
    minSetpointDeadBand: 0,
    // Provide reasonable defaults for setpoints to prevent undefined->NaN issues
    // These will be overwritten with actual HA values during initialize()
    localTemperature: 2100, // 21°C - reasonable room temperature default
    occupiedHeatingSetpoint: 2000, // 20°C in 0.01°C units
    occupiedCoolingSetpoint: 2400, // 24°C in 0.01°C units
    // Limits must satisfy: minHeat <= minCool (when deadband=0)
    minHeatSetpointLimit: 700, // 7°C
    maxHeatSetpointLimit: 3000, // 30°C
    minCoolSetpointLimit: 700, // 7°C - same as heat to satisfy constraint
    maxCoolSetpointLimit: 3200, // 32°C
    // Absolute limits
    absMinHeatSetpointLimit: 700,
    absMaxHeatSetpointLimit: 3000,
    absMinCoolSetpointLimit: 700,
    absMaxCoolSetpointLimit: 3200,
  });
}
