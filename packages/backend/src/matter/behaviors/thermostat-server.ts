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

import type { ActionContext, Agent } from "@matter/main";
import { StatusCode, StatusResponseError } from "@matter/main/types";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";

// Tracks entity IDs currently receiving a nudge write from update().
// Prevents the nudge itself from triggering auto-resume in $Changing handlers.
const nudgingSetpoints = new Set<string>();

// Entity IDs whose auto-resume already sent the mode change to HA (#519).
// The systemMode$Changed reactor consumes the entry and skips the duplicate.
// An entry older than AUTO_RESUME_MS is stale (no $Changed after the resume)
// and must not swallow a later controller write of that mode.
const autoResuming = new Map<string, { mode: SystemMode; at: number }>();
const AUTO_RESUME_MS = 2000;

/**
 * Nudge a setpoint by +1 centidegree (0.01°C) so that any controller write
 * of the "real" value produces a value change and triggers $Changing.
 * If already at the max limit, nudge -1 instead to stay within bounds.
 */
function nudgeSetpoint(value: number | undefined, maxLimit: number): number {
  if (value == null) return 2000; // fallback 20°C
  return value >= maxLimit ? value - 1 : value + 1;
}

// For dual-mode thermostats (heating + cooling), AutoMode is ENABLED so Apple Home
// can offer Auto mode and dual setpoints. Without AutoMode, Apple Home loses Auto.
//
// localTemperature: null when current_temperature is unavailable (not setpoint!)
//   Apple Home uses localTemp vs setpoint comparison for "Heating to..." display.
//   Setting localTemp = setpoint makes Apple Home think target is already reached.
// thermostatRunningMode: Set ONLY for Auto mode from hvac_action. Matter.js reactor
//   handles Heat/Cool/Off but SKIPS Auto, without our update, switching Heat→Auto
//   leaves runningMode stale at Heat. (889010b: all modes = conflict, 0678d35: none
//   = stale, da04b2e: Auto only = correct)
// thermostatRunningState: Set from hvac_action for controllers that support it.
//
// For heat-only / cool-only devices, AutoMode is NOT enabled:
// - Prevents Alexa from expecting dual setpoints (→ "not supported" errors)

// Default state values for each feature combination.
// These MUST be set via .set() when creating the behavior class because Matter.js
// validates setpoints before our initialize() method runs.
//
// thermostatRunningState (optional attribute) MUST be initialized here so
// controllers discover and subscribe to it from the start. Without this,
// Apple Home cannot distinguish "Heating to 26" (active) from "Heat to 26" (idle).
const runningStateAllOff = {
  heat: false,
  cool: false,
  fan: false,
  heatStage2: false,
  coolStage2: false,
  fanStage2: false,
  fanStage3: false,
};

const heatingOnlyDefaults = {
  localTemperature: 2100, // 21°C
  occupiedHeatingSetpoint: 2000, // 20°C
  minHeatSetpointLimit: 0,
  maxHeatSetpointLimit: 5000,
  absMinHeatSetpointLimit: 0,
  absMaxHeatSetpointLimit: 5000,
  thermostatRunningState: runningStateAllOff,
};

const coolingOnlyDefaults = {
  localTemperature: 2100, // 21°C
  occupiedCoolingSetpoint: 2400, // 24°C
  minCoolSetpointLimit: 0,
  maxCoolSetpointLimit: 5000,
  absMinCoolSetpointLimit: 0,
  absMaxCoolSetpointLimit: 5000,
  thermostatRunningState: runningStateAllOff,
};

// Full defaults include both heating, cooling, and AutoMode.
// minSetpointDeadBand: 0 allows heat/cool setpoints to be equal (no gap required).
const fullDefaults = {
  ...heatingOnlyDefaults,
  ...coolingOnlyDefaults,
  minSetpointDeadBand: 0,
};

// Feature-specific bases for different thermostat types.
// Controllers like Alexa use these feature flags to determine capabilities.
// A heat-only thermostat with Cooling feature causes Alexa to expect dual setpoints
// and refuse single-temperature commands ("not supported").
// See: https://github.com/RiDDiX/home-assistant-matter-hub/issues/136
const HeatingOnlyFeaturedBase = Base.with("Heating").set(heatingOnlyDefaults);
const CoolingOnlyFeaturedBase = Base.with("Cooling").set(coolingOnlyDefaults);
const FullFeaturedBase = Base.with("Heating", "Cooling", "AutoMode").set(
  fullDefaults,
);

// Heating + Cooling WITHOUT AutoMode. For devices that support both heat and cool
// but not dual setpoints (no heat_cool mode in HA). Apple Home won't show Auto.
const heatingAndCoolingDefaults = {
  ...heatingOnlyDefaults,
  ...coolingOnlyDefaults,
};
const HeatingAndCoolingFeaturedBase = Base.with("Heating", "Cooling").set(
  heatingAndCoolingDefaults,
);

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
  getControlSequence: ValueGetter<Thermostat.ControlSequenceOfOperation>;

  setSystemMode: ValueSetter<SystemMode>;
  // resumeMode: the mode an auto-resume from Off sent just before (#547).
  setTargetTemperature: (
    value: Temperature,
    agent: Agent,
    resumeMode?: SystemMode,
  ) => HomeAssistantAction;
  setTargetTemperatureRange: ValueSetter<{
    low: Temperature;
    high: Temperature;
  }>;
}

export interface SetpointLimits {
  absMin: number;
  min: number;
  max: number;
  absMax: number;
}

// Make a setpoint-limit set satisfy absMin <= min <= max <= absMax. An old
// build could persist limits in the wrong unit (e.g. 61F stored as 6100 instead
// of 1611), and matter.js keeps the stored value over our defaults, so a stuck
// device fails init every restart until the loaded state is repaired (#375).
export function repairSetpointLimits(limits: SetpointLimits): SetpointLimits {
  let { min, max } = limits;
  if (min > max) [min, max] = [max, min];
  return {
    min,
    max,
    absMin: Math.min(limits.absMin, min),
    absMax: Math.max(limits.absMax, max),
  };
}

// matter.js validates Heat and Cool setpoint state on init no matter the
// featureMap, so limits or an occupied setpoint left over from a former
// heat<->cool config crash a now single-feature device (code 135, #381/#384).
// Clear the inactive scope to undefined, the only value matter.js accepts for a
// disabled attribute, so it falls back to its own defaults.
// biome-ignore lint/suspicious/noExplicitAny: works across feature variants
function clearInactiveSetpointState(self: any, scope: "Heat" | "Cool"): void {
  for (const key of [
    `absMin${scope}SetpointLimit`,
    `min${scope}SetpointLimit`,
    `max${scope}SetpointLimit`,
    `absMax${scope}SetpointLimit`,
    `occupied${scope === "Heat" ? "Heating" : "Cooling"}Setpoint`,
  ]) {
    if (self.state[key] !== undefined) self.state[key] = undefined;
  }
}

/**
 * Pre-super initialization: force-set feature-appropriate attribute values.
 * Must run BEFORE super.initialize() because Matter.js validates setpoints during super.
 * Extracted as standalone function so each feature-variant class can call it
 * from its own initialize() with correct super binding.
 */
// biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
export function thermostatPreInitialize(self: any): void {
  const currentLocal = self.state.localTemperature;

  logger.debug(
    `initialize: features - heating=${self.features.heating}, cooling=${self.features.cooling}`,
  );

  // Force-set local temperature. null is valid per Matter spec (nullable int16).
  const localValue =
    typeof currentLocal === "number" && !Number.isNaN(currentLocal)
      ? currentLocal
      : currentLocal === null
        ? null
        : 2100;
  self.state.localTemperature = localValue;

  // Force-set heating values (only if Heating feature enabled)
  // IMPORTANT: Set limits BEFORE setpoints! Matter.js may validate setpoints
  // against abs limits during property writes. For negative temperatures
  // (e.g. refrigerators at -18°C), the default absMin of 0 would reject the setpoint.
  if (self.features.heating) {
    self.state.absMinHeatSetpointLimit =
      self.state.absMinHeatSetpointLimit ?? 0;
    self.state.absMaxHeatSetpointLimit =
      self.state.absMaxHeatSetpointLimit ?? 5000;
    self.state.minHeatSetpointLimit = self.state.minHeatSetpointLimit ?? 0;
    self.state.maxHeatSetpointLimit = self.state.maxHeatSetpointLimit ?? 5000;

    const heat = repairSetpointLimits({
      absMin: self.state.absMinHeatSetpointLimit,
      min: self.state.minHeatSetpointLimit,
      max: self.state.maxHeatSetpointLimit,
      absMax: self.state.absMaxHeatSetpointLimit,
    });
    self.state.absMinHeatSetpointLimit = heat.absMin;
    self.state.minHeatSetpointLimit = heat.min;
    self.state.maxHeatSetpointLimit = heat.max;
    self.state.absMaxHeatSetpointLimit = heat.absMax;

    const currentHeating = self.state.occupiedHeatingSetpoint;
    const heatingValue =
      typeof currentHeating === "number" && !Number.isNaN(currentHeating)
        ? currentHeating
        : 2000;
    self.state.occupiedHeatingSetpoint = heatingValue;
  } else {
    clearInactiveSetpointState(self, "Heat");
  }

  // Force-set cooling values (only if Cooling feature enabled)
  // Same ordering: limits first, then setpoints.
  if (self.features.cooling) {
    self.state.absMinCoolSetpointLimit =
      self.state.absMinCoolSetpointLimit ?? 0;
    self.state.absMaxCoolSetpointLimit =
      self.state.absMaxCoolSetpointLimit ?? 5000;
    self.state.minCoolSetpointLimit = self.state.minCoolSetpointLimit ?? 0;
    self.state.maxCoolSetpointLimit = self.state.maxCoolSetpointLimit ?? 5000;

    const cool = repairSetpointLimits({
      absMin: self.state.absMinCoolSetpointLimit,
      min: self.state.minCoolSetpointLimit,
      max: self.state.maxCoolSetpointLimit,
      absMax: self.state.absMaxCoolSetpointLimit,
    });
    self.state.absMinCoolSetpointLimit = cool.absMin;
    self.state.minCoolSetpointLimit = cool.min;
    self.state.maxCoolSetpointLimit = cool.max;
    self.state.absMaxCoolSetpointLimit = cool.absMax;

    const currentCooling = self.state.occupiedCoolingSetpoint;
    const coolingValue =
      typeof currentCooling === "number" && !Number.isNaN(currentCooling)
        ? currentCooling
        : 2400;
    self.state.occupiedCoolingSetpoint = coolingValue;
  } else {
    clearInactiveSetpointState(self, "Cool");
  }

  logger.debug(
    `initialize: after force-set - local=${self.state.localTemperature}`,
  );

  // Initialize thermostatRunningState (optional attribute) so controllers
  // subscribe to it from the start. This is the bitmap that indicates active
  // heating/cooling.
  self.state.thermostatRunningState = runningStateAllOff;

  // minSetpointDeadBand and thermostatRunningMode only exist with AutoMode. A
  // former AutoMode config can persist them onto a now non-AutoMode base, which
  // fails conformance on init like the setpoints do (code 135, #384).
  if (self.features.autoMode) {
    // Keep this inside the autoMode branch, writing the attribute on a base
    // without AutoMode crashes the endpoint ("Behaviors have errors"). The
    // assignment must stay "= 0", never "?? 0": the attribute is quality N
    // with a 2°C model default (20) that survives "??", and pre-super
    // initialize is the only window where the write sticks. HA has no such
    // gap between the heat and cool setpoints.
    self.state.minSetpointDeadBand = 0;
  } else {
    if (self.state.minSetpointDeadBand !== undefined)
      self.state.minSetpointDeadBand = undefined;
    if (self.state.thermostatRunningMode !== undefined)
      self.state.thermostatRunningMode = undefined;
  }

  // Set initial controlSequenceOfOperation based on enabled features.
  // CoolingAndHeating is only safe for AutoMode devices (HEAT+COOL+AUTO features).
  // Non-AutoMode devices with both features use HeatingOnly as safe initial value;
  // update() will set the correct dynamic value via internal override (#28).
  self.state.controlSequenceOfOperation =
    self.features.cooling && self.features.heating && self.features.autoMode
      ? Thermostat.ControlSequenceOfOperation.CoolingAndHeating
      : self.features.heating
        ? Thermostat.ControlSequenceOfOperation.HeatingOnly
        : Thermostat.ControlSequenceOfOperation.CoolingOnly;
}

/**
 * Post-super initialization: load HA entity, run first update, wire up reactors.
 * Must run AFTER super.initialize() because agent/events aren't ready before.
 * Extracted as standalone function so each feature-variant class can call it
 * from its own initialize() with correct super binding.
 */
// biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
async function thermostatPostInitialize(self: any): Promise<void> {
  const homeAssistant = await self.agent.load(HomeAssistantEntityBehavior);
  self.update(homeAssistant.entity);

  self.reactTo(self.events.systemMode$Changing, self.systemModeChanging);
  self.reactTo(self.events.systemMode$Changed, self.systemModeChanged);
  // Use $Changing (pre-commit) for setpoint changes to avoid access control issues
  // The $Changed event fires in post-commit where we lose write permissions
  if (self.features.cooling) {
    self.reactTo(
      self.events.occupiedCoolingSetpoint$Changing,
      self.coolingSetpointChanging,
    );
  }
  if (self.features.heating) {
    self.reactTo(
      self.events.occupiedHeatingSetpoint$Changing,
      self.heatingSetpointChanging,
    );
  }
  self.reactTo(homeAssistant.onChange, self.update, { lock: true });
}

export class ThermostatServerBase extends FullFeaturedBase {
  declare state: ThermostatServerBase.State;

  // State class only declares the config property type.
  // ALL defaults are set via .set() in the ThermostatServer function below
  // so matter.js's internal cluster data store picks them up before init.
  static override State = class State extends FullFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;
    const config = this.state.config;

    // When unavailable, keep last known values but report offline via BasicInformation.reachable
    // Only update temperatures if entity is available to prevent null/invalid values
    const isAvailable = homeAssistant.isAvailable;

    const minSetpointLimit = isAvailable
      ? config.getMinTemperature(entity.state, this.agent)?.celsius(true)
      : this.features.heating
        ? this.state.minHeatSetpointLimit
        : this.state.minCoolSetpointLimit;
    const maxSetpointLimit = isAvailable
      ? config.getMaxTemperature(entity.state, this.agent)?.celsius(true)
      : this.features.heating
        ? this.state.maxHeatSetpointLimit
        : this.state.maxCoolSetpointLimit;
    const currentTemperature = isAvailable
      ? config.getCurrentTemperature(entity.state, this.agent)?.celsius(true)
      : this.state.localTemperature;
    const haHeatingTemperature =
      this.features.heating && isAvailable
        ? config
            .getTargetHeatingTemperature(entity.state, this.agent)
            ?.celsius(true)
        : undefined;
    const haCoolingTemperature =
      this.features.cooling && isAvailable
        ? config
            .getTargetCoolingTemperature(entity.state, this.agent)
            ?.celsius(true)
        : undefined;
    const targetHeatingTemperature = this.features.heating
      ? (haHeatingTemperature ?? this.state.occupiedHeatingSetpoint)
      : undefined;
    const targetCoolingTemperature = this.features.cooling
      ? (haCoolingTemperature ?? this.state.occupiedCoolingSetpoint)
      : undefined;
    // A stored setpoint read back while Off already carries the nudge.
    const wasOff = this.state.systemMode === Thermostat.SystemMode.Off;

    const systemMode = isAvailable
      ? this.getSystemMode(entity)
      : (this.state.systemMode ?? Thermostat.SystemMode.Off);
    const runningMode = isAvailable
      ? config.getRunningMode(entity.state, this.agent)
      : Thermostat.ThermostatRunningMode.Off;

    // Temperature limit handling:
    // Use HA's actual min/max limits for ALL modes (single and dual).
    // minSetpointDeadBand: 0 for full HVAC devices (no gap between heat/cool setpoints).
    // Fall back to wide limits (0-50°C) only when HA doesn't provide limits.
    const WIDE_MIN = 0; // 0°C
    const WIDE_MAX = 5000; // 50°C

    let minHeatLimit: number | undefined;
    let minCoolLimit: number | undefined;
    let maxHeatLimit: number | undefined;
    let maxCoolLimit: number | undefined;

    if (this.features.heating) {
      minHeatLimit = minSetpointLimit ?? WIDE_MIN;
      maxHeatLimit = maxSetpointLimit ?? WIDE_MAX;
      // Matter requires min <= max; HA can report them inverted (#375).
      if (minHeatLimit > maxHeatLimit) {
        [minHeatLimit, maxHeatLimit] = [maxHeatLimit, minHeatLimit];
      }
    }
    if (this.features.cooling) {
      minCoolLimit = minSetpointLimit ?? WIDE_MIN;
      maxCoolLimit = maxSetpointLimit ?? WIDE_MAX;
      if (minCoolLimit > maxCoolLimit) {
        [minCoolLimit, maxCoolLimit] = [maxCoolLimit, minCoolLimit];
      }
    }

    // Clamp setpoints to be within the calculated limits to prevent Matter.js validation errors
    // This handles cases where HA reports setpoints outside the valid range
    const clampedHeatingSetpoint = this.clampSetpoint(
      targetHeatingTemperature,
      minHeatLimit,
      maxHeatLimit,
      "heat",
    );
    const clampedCoolingSetpoint = this.clampSetpoint(
      targetCoolingTemperature,
      minCoolLimit,
      maxCoolLimit,
      "cool",
    );

    // Avoid controller 0 C or out-of-range fallback values (#470).
    const localTemperature =
      typeof currentTemperature === "number" &&
      !Number.isNaN(currentTemperature)
        ? currentTemperature
        : targetHeatingTemperature != null
          ? clampedHeatingSetpoint
          : targetCoolingTemperature != null
            ? clampedCoolingSetpoint
            : null;

    logger.debug(
      `update: limits heat=[${minHeatLimit}, ${maxHeatLimit}], cool=[${minCoolLimit}, ${maxCoolLimit}], systemMode=${systemMode}, runningMode=${runningMode}`,
    );

    // Compute controlSequenceOfOperation and update the internal value BEFORE
    // writing to state. Matter.js's ThermostatBaseServer stores this in
    // internal.controlSequenceOfOperation and has a $Changing reactor that
    // reverts any state write back to the internal value. We must update
    // internal first so the reactor allows our new value through. The
    // systemMode $Changing reactor also validates against the internal value.
    let controlSequence = config.getControlSequence(entity.state, this.agent);
    // Clamp controlSequenceOfOperation to match enabled features.
    // Config callbacks may return values incompatible with the thermostat's
    // actual feature set (e.g., HeatingOnly for a cooling-only AC with 'auto').
    controlSequence = this.clampControlSequence(controlSequence);
    // biome-ignore lint/suspicious/noExplicitAny: Access protected internal state from Matter.js base
    (this as any).internal.controlSequenceOfOperation = controlSequence;

    // Property order matters: applyPatchState sets properties sequentially, so if one
    // property write triggers an error, subsequent properties won't be set.
    // Limits are set FIRST to ensure they're applied even if mode changes trigger errors.
    applyPatchState(this.state, {
      // abs limits BEFORE user limits: on a widening update the user limit
      // must never transiently sit outside the still-narrow abs limit, the
      // reactor asserts against abs on every write (#454 hardening)
      ...(this.features.heating
        ? {
            absMinHeatSetpointLimit: minHeatLimit,
            absMaxHeatSetpointLimit: maxHeatLimit,
            minHeatSetpointLimit: minHeatLimit,
            maxHeatSetpointLimit: maxHeatLimit,
          }
        : {}),
      ...(this.features.cooling
        ? {
            absMinCoolSetpointLimit: minCoolLimit,
            absMaxCoolSetpointLimit: maxCoolLimit,
            minCoolSetpointLimit: minCoolLimit,
            maxCoolSetpointLimit: maxCoolLimit,
          }
        : {}),
      localTemperature: localTemperature,
      controlSequenceOfOperation: controlSequence,
      thermostatRunningState: this.getRunningState(systemMode, runningMode),
      systemMode: systemMode,
      // thermostatRunningMode: Only set for Auto mode. Matter.js's reactor handles
      // Heat/Cool/Off but SKIPS Auto (see #handleSystemModeChange in Matter.js).
      // Without this, switching Heat→Auto leaves runningMode stale at Heat.
      // 889010b set for ALL modes (conflicted with reactor), 0678d35 set for NONE
      // (stale in Auto). da04b2e's Auto-only approach is correct, the issues
      // reported after it were caused by localTemperature fallback, not runningMode.
      ...(this.features.heating &&
      this.features.cooling &&
      systemMode === Thermostat.SystemMode.Auto
        ? { thermostatRunningMode: runningMode }
        : {}),
    });

    // Setpoints are applied in a separate patch wrapped with the nudgingSetpoints
    // guard. When Off, setpoints are nudged by +1 centidegree (0.01°C) so any
    // controller write, even the "same" temperature, triggers $Changing for
    // auto-resume (#176). The guard prevents the nudge itself from auto-resuming.
    nudgingSetpoints.add(entityId);
    try {
      applyPatchState(this.state, {
        ...(this.features.heating
          ? {
              occupiedHeatingSetpoint:
                systemMode === Thermostat.SystemMode.Off &&
                (haHeatingTemperature != null ||
                  !wasOff ||
                  clampedHeatingSetpoint !== this.state.occupiedHeatingSetpoint)
                  ? nudgeSetpoint(
                      clampedHeatingSetpoint,
                      maxHeatLimit ?? WIDE_MAX,
                    )
                  : clampedHeatingSetpoint,
            }
          : {}),
        ...(this.features.cooling
          ? {
              occupiedCoolingSetpoint:
                systemMode === Thermostat.SystemMode.Off &&
                (haCoolingTemperature != null ||
                  !wasOff ||
                  clampedCoolingSetpoint !== this.state.occupiedCoolingSetpoint)
                  ? nudgeSetpoint(
                      clampedCoolingSetpoint,
                      maxCoolLimit ?? WIDE_MAX,
                    )
                  : clampedCoolingSetpoint,
            }
          : {}),
      });
    } finally {
      nudgingSetpoints.delete(entityId);
    }
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
    // HA can sit outside the limits the controller saw (4 vs min 10).
    heat = this.clampToLimits(
      (heat ?? cool)!,
      this.state.minHeatSetpointLimit ?? this.state.minCoolSetpointLimit,
      this.state.maxHeatSetpointLimit ?? this.state.maxCoolSetpointLimit,
      "heat",
    );
    cool = this.clampToLimits(
      (cool ?? heat)!,
      this.state.minCoolSetpointLimit ?? this.state.minHeatSetpointLimit,
      this.state.maxCoolSetpointLimit ?? this.state.maxHeatSetpointLimit,
      "cool",
    );

    let resumed: SystemMode | undefined;
    if (
      this.state.systemMode === SystemMode.Off &&
      !config.supportsTemperatureRange(state, this.agent)
    ) {
      // Fail before the resume, not after its mode call went out.
      homeAssistant.assertAvailable();
      this.agent.asLocalActor(() => {
        resumed = this.autoResumeFromOff(
          request.mode === Thermostat.SetpointRaiseLowerMode.Cool
            ? SystemMode.Cool
            : SystemMode.Heat,
          "setpointRaiseLower",
        );
      });
    }

    // Matter spec: amount is in 0.1°C steps (tenths of a degree).
    // Divide by 10 to convert to °C for the Temperature.plus() method.
    const adjustedCool =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Heat
        ? cool.plus(request.amount / 10, "°C")
        : cool;
    const adjustedHeat =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Cool
        ? heat.plus(request.amount / 10, "°C")
        : heat;
    this.setTemperature(adjustedHeat, adjustedCool, request.mode, resumed);
  }

  private clampToLimits(
    value: Temperature,
    min: number | undefined,
    max: number | undefined,
    kind: "heat" | "cool",
  ): Temperature {
    return Temperature.celsius(
      this.clampSetpoint(value.celsius(true), min, max, kind) / 100,
    )!;
  }

  // Pre-commit handlers: $Changing instead of $Changed keeps write permission
  // for the Home Assistant action.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private heatingSetpointChanging(
    value: number,
    oldValue: number,
    context?: ActionContext,
  ) {
    this.setpointChanging("heat", value, oldValue, context);
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private coolingSetpointChanging(
    value: number,
    oldValue: number,
    context?: ActionContext,
  ) {
    this.setpointChanging("cool", value, oldValue, context);
  }

  private setpointChanging(
    kind: "heat" | "cool",
    value: number,
    oldValue: number,
    context?: ActionContext,
  ) {
    const heat = kind === "heat";
    const source = heat ? "heatingSetpointChanging" : "coolingSetpointChanging";
    logger.debug(
      `${source}: value=${value}, oldValue=${oldValue}, isOffline=${transactionIsOffline(context)}`,
    );
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

      let resumed: SystemMode | undefined;
      // For single-temperature thermostats, determine if this setpoint should update HA.
      // We check the ACTUAL HA hvac_mode to handle auto mode correctly.
      if (!supportsRange) {
        const currentMode = this.state.systemMode;
        const haHvacMode = homeAssistant.entity.state.state;
        const isAutoMode = haHvacMode === "auto" || haHvacMode === "heat_cool";
        const isOwnMode = heat
          ? currentMode === SystemMode.Heat ||
            currentMode === SystemMode.EmergencyHeat
          : currentMode === SystemMode.Cool ||
            currentMode === SystemMode.Precooling;
        // Dry and FanOnly have no direction: one handler owns the single
        // temperature, so a write of both setpoints still calls HA once.
        const ownsDirectionless =
          (currentMode === SystemMode.Dry ||
            currentMode === SystemMode.FanOnly) &&
          heat === !this.features.cooling;
        const isOff = currentMode === SystemMode.Off;

        if (isOff && (heat ? this.features.heating : this.features.cooling)) {
          // Auto-resume (#176, #519): controller wrote a setpoint while Off.
          // #519: cooling writes on heat+cool devices used to be dropped.
          // The nudge in update() ensures $Changing fires even for same-value writes.
          // Skip if this $Changing was caused by the nudge itself (not a controller write).
          if (nudgingSetpoints.has(homeAssistant.entityId)) {
            logger.debug(
              `${source}: skipping auto-resume - nudge write in progress`,
            );
            return;
          }
          resumed = this.autoResumeFromOff(
            heat ? SystemMode.Heat : SystemMode.Cool,
            source,
          );
          // Proceed to forward the temperature to HA below.
        } else if (!isAutoMode && !isOwnMode && !ownsDirectionless) {
          // Auto mode: both setpoints update temperature (#71). Otherwise the
          // handler of the active direction forwards it.
          logger.debug(
            `${source}: skipping - not in own/auto mode (mode=${currentMode}, haMode=${haHvacMode})`,
          );
          return;
        }
      }

      if (heat) {
        const coolingSetpoint = this.features.cooling
          ? this.state.occupiedCoolingSetpoint
          : value;
        this.setTemperature(
          next,
          Temperature.celsius(coolingSetpoint / 100)!,
          Thermostat.SetpointRaiseLowerMode.Heat,
          resumed,
        );
      } else {
        const heatingSetpoint = this.features.heating
          ? this.state.occupiedHeatingSetpoint
          : value;
        this.setTemperature(
          Temperature.celsius(heatingSetpoint / 100)!,
          next,
          Thermostat.SetpointRaiseLowerMode.Cool,
          resumed,
        );
      }
    });
  }

  private setTemperature(
    low: Temperature,
    high: Temperature,
    mode: Thermostat.SetpointRaiseLowerMode,
    resumed?: SystemMode,
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
      // Range mode never auto-resumes: isTemperatureRangeActive needs a non-Off HA mode.
      action = config.setTargetTemperature(both, this.agent, resumed);
    }
    homeAssistant.callAction(action);
  }

  // Auto-resume from Off (#176, #519): send the mode to HA and optimistically
  // set systemMode so controllers stop reading Off until HA confirms (Alexa
  // answers "not responding" whenever systemMode reads Off). The state write
  // also makes the sibling setpoint handler see a non-Off mode within the same
  // transaction, so writing both setpoints at once resumes exactly once: the
  // first attribute in the write picks the mode (intent is ambiguous while
  // Off, so first-wins is the pinned rule, asserted in the #519 bringup test).
  private autoResumeFromOff(preferred: SystemMode, source: string): SystemMode {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const resumeMode = this.resumeModeFor(preferred);
    logger.info(
      `${source}: auto-resume - switching to ${SystemMode[resumeMode]} (was Off)`,
    );
    // State write first: if it throws, no HA side effect happened yet.
    this.state.systemMode = resumeMode;
    autoResuming.set(homeAssistant.entityId, {
      mode: resumeMode,
      at: Date.now(),
    });
    homeAssistant.callAction(
      this.state.config.setSystemMode(resumeMode, this.agent),
    );
    return resumeMode;
  }

  // Flip to the sibling mode when controlSequenceOfOperation forbids the
  // preferred one; matter.js asserts the same table on systemMode$Changing.
  private resumeModeFor(preferred: SystemMode): SystemMode {
    // biome-ignore lint/suspicious/noExplicitAny: Access protected internal state from Matter.js base
    const cso = (this as any).internal.controlSequenceOfOperation;
    const Cso = Thermostat.ControlSequenceOfOperation;
    if (
      preferred === SystemMode.Heat &&
      (cso === Cso.CoolingOnly || cso === Cso.CoolingAndHeatingWithReheat)
    ) {
      return SystemMode.Cool;
    }
    if (
      preferred === SystemMode.Cool &&
      (cso === Cso.HeatingOnly || cso === Cso.HeatingWithReheat)
    ) {
      return SystemMode.Heat;
    }
    return preferred;
  }

  // climateBlockOff (#527): refuse Off from controllers. Off is an optional
  // SystemMode value, so ConstraintError is the spec answer. Apple's Matter
  // framework drops its expected Off on a failed write; after an accepted one
  // it filters our reports until that expected value times out.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private systemModeChanging(
    systemMode: Thermostat.SystemMode,
    _oldValue: Thermostat.SystemMode,
    context?: ActionContext,
  ) {
    if (
      transactionIsOffline(context) ||
      (systemMode !== SystemMode.Off && systemMode !== SystemMode.Sleep)
    ) {
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (homeAssistant.state.mapping?.climateBlockOff === true) {
      throw new StatusResponseError(
        `${SystemMode[systemMode]} is blocked for this thermostat (climateBlockOff)`,
        StatusCode.ConstraintError,
      );
    }
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
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
      // Always consume a pending auto-resume entry; skip only on a match so a
      // stale entry can never swallow a different mode change (#519).
      const expected = autoResuming.get(homeAssistant.entityId);
      autoResuming.delete(homeAssistant.entityId);
      if (
        expected?.mode === systemMode &&
        Date.now() - expected.at < AUTO_RESUME_MS
      ) {
        // The setpoint auto-resume already sent this mode to HA.
        return;
      }
      const action = this.state.config.setSystemMode(systemMode, this.agent);
      homeAssistant.callAction(action);
    });
  }

  private getSystemMode(entity: HomeAssistantEntityInformation) {
    // Clamp to the active features so a heat/cool flip can't put Heat on a
    // cooling-only base (or Auto without AutoMode) and crash init (#319, #381).
    return this.clampSystemMode(
      this.state.config.getSystemMode(entity.state, this.agent),
    );
  }

  private clampSystemMode(value: SystemMode): SystemMode {
    const { heating, cooling, autoMode } = this.features;
    if (
      (value === SystemMode.Heat || value === SystemMode.EmergencyHeat) &&
      !heating
    ) {
      return cooling ? SystemMode.Cool : SystemMode.Off;
    }
    if (
      (value === SystemMode.Cool || value === SystemMode.Precooling) &&
      !cooling
    ) {
      return heating ? SystemMode.Heat : SystemMode.Off;
    }
    if (value === SystemMode.Auto && !autoMode) {
      return cooling
        ? SystemMode.Cool
        : heating
          ? SystemMode.Heat
          : SystemMode.Off;
    }
    return value;
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

    // runningMode (derived from hvac_action) is the primary signal for
    // active heating/cooling, Apple Home reads it to distinguish
    // "Heating to 26" (active) from "Heat to 26" (mode selected, idle).
    // FanOnly/Dry have no RunningMode equivalent, so we fall back to systemMode.
    switch (runningMode) {
      case RunningMode.Heat:
        return heat;
      case RunningMode.Cool:
        return cool;
      case RunningMode.Off:
        // Not actively heating/cooling. For FanOnly/Dry, still indicate activity
        // based on systemMode since these modes have no RunningMode equivalent.
        switch (systemMode) {
          case SystemMode.FanOnly:
            return fanOnly;
          case SystemMode.Dry:
            return dry;
          default:
            return allOff;
        }
      default:
        // Future matter.js RunningMode values (e.g. alternative heat/cool)
        // fall through to "nothing running" rather than emitting undefined.
        return allOff;
    }
  }

  private clampControlSequence(
    value: Thermostat.ControlSequenceOfOperation,
  ): Thermostat.ControlSequenceOfOperation {
    const hasHeat = this.features.heating;
    const hasCool = this.features.cooling;
    const needsHeat =
      value === Thermostat.ControlSequenceOfOperation.HeatingOnly ||
      value === Thermostat.ControlSequenceOfOperation.HeatingWithReheat;
    const needsCool =
      value === Thermostat.ControlSequenceOfOperation.CoolingOnly ||
      value === Thermostat.ControlSequenceOfOperation.CoolingWithReheat;
    const needsBoth =
      value === Thermostat.ControlSequenceOfOperation.CoolingAndHeating ||
      value ===
        Thermostat.ControlSequenceOfOperation.CoolingAndHeatingWithReheat;
    if (needsHeat && !hasHeat) {
      return Thermostat.ControlSequenceOfOperation.CoolingOnly;
    }
    if (needsCool && !hasCool) {
      return Thermostat.ControlSequenceOfOperation.HeatingOnly;
    }
    if (needsBoth && !hasHeat) {
      return Thermostat.ControlSequenceOfOperation.CoolingOnly;
    }
    if (needsBoth && !hasCool) {
      return Thermostat.ControlSequenceOfOperation.HeatingOnly;
    }
    return value;
  }

  private clampSetpoint(
    value: number | undefined,
    min: number | undefined,
    max: number | undefined,
    type: "heat" | "cool",
  ): number {
    // Use reasonable defaults if limits not provided
    const effectiveMin = min ?? 0; // 0°C
    const effectiveMax = max ?? 5000; // 50°C

    // If value is undefined or NaN, use a reasonable default based on type
    // Heat defaults to 20°C (2000), Cool defaults to 24°C (2400)
    if (value == null || Number.isNaN(value)) {
      const defaultValue = type === "heat" ? 2000 : 2400;
      logger.debug(
        `${type} setpoint is undefined, using default: ${defaultValue}`,
      );
      return Math.max(effectiveMin, Math.min(effectiveMax, defaultValue));
    }

    // Clamp value to be within limits
    return Math.max(effectiveMin, Math.min(effectiveMax, value));
  }
}

export namespace ThermostatServerBase {
  export type State = InstanceType<typeof ThermostatServerBase.State>;
}

// Feature-specific thermostat variants that share the same implementation
// but advertise only the features they actually support.
// This is critical for controllers like Alexa that use feature flags to
// determine thermostat capabilities (single vs dual setpoint).
// See: https://github.com/RiDDiX/home-assistant-matter-hub/issues/136
// biome-ignore lint/correctness/noUnusedVariables: Used via copyPrototypeMethods and in ThermostatServer factory
class HeatingOnlyThermostatServerBase extends HeatingOnlyFeaturedBase {
  declare state: HeatingOnlyThermostatServerBase.State;
  static override State = class extends HeatingOnlyFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  // Each variant MUST define its own initialize() so that super.initialize()
  // resolves to the correct parent class (HeatingOnlyFeaturedBase here).
  // Copying initialize() via prototype manipulation would bind super to
  // FullFeaturedBase due to JavaScript's [[HomeObject]] semantics.
  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }
}
namespace HeatingOnlyThermostatServerBase {
  export type State = InstanceType<
    typeof HeatingOnlyThermostatServerBase.State
  >;
}

// biome-ignore lint/correctness/noUnusedVariables: Used via copyPrototypeMethods and in ThermostatServer factory
class CoolingOnlyThermostatServerBase extends CoolingOnlyFeaturedBase {
  declare state: CoolingOnlyThermostatServerBase.State;
  static override State = class extends CoolingOnlyFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  // Each variant MUST define its own initialize(), see HeatingOnly comment above.
  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }
}
namespace CoolingOnlyThermostatServerBase {
  export type State = InstanceType<
    typeof CoolingOnlyThermostatServerBase.State
  >;
}

// Share implementation from ThermostatServerBase to feature-specific variants.
// IMPORTANT: initialize() is EXCLUDED because JavaScript's [[HomeObject]] semantics
// bind super to the class where the method was originally defined. Copying initialize()
// would make super.initialize() always call FullFeaturedBase instead of the variant's
// actual parent. Each variant defines its own initialize() above.
// All other methods are safe to copy because they don't use super.
// biome-ignore lint/suspicious/noExplicitAny: Prototype manipulation requires any
function copyPrototypeMethods(source: any, target: any) {
  for (const name of Object.getOwnPropertyNames(source.prototype)) {
    if (name === "constructor" || name === "initialize") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source.prototype, name);
    if (descriptor) {
      Object.defineProperty(target.prototype, name, descriptor);
    }
  }
}
// biome-ignore lint/correctness/noUnusedVariables: Used via copyPrototypeMethods and in ThermostatServer factory
class HeatingAndCoolingThermostatServerBase extends HeatingAndCoolingFeaturedBase {
  declare state: HeatingAndCoolingThermostatServerBase.State;
  static override State = class extends HeatingAndCoolingFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  // Each variant MUST define its own initialize(), see HeatingOnly comment above.
  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }
}
namespace HeatingAndCoolingThermostatServerBase {
  export type State = InstanceType<
    typeof HeatingAndCoolingThermostatServerBase.State
  >;
}

copyPrototypeMethods(ThermostatServerBase, HeatingOnlyThermostatServerBase);
copyPrototypeMethods(ThermostatServerBase, CoolingOnlyThermostatServerBase);
copyPrototypeMethods(
  ThermostatServerBase,
  HeatingAndCoolingThermostatServerBase,
);

export interface ThermostatServerFeatures {
  heating: boolean;
  cooling: boolean;
  /**
   * Enable AutoMode (dual setpoint) feature.
   * Only set to true if the device supports heat_cool in HA hvac_modes.
   * Without this, Apple Home won't show the Auto option, preventing
   * mode flipping on devices that only have single-setpoint 'auto'.
   */
  autoMode?: boolean;
}

/**
 * Initial state values for the thermostat.
 * These MUST be provided when creating the behavior to prevent NaN validation errors.
 * Matter.js validates setpoints during initialization BEFORE our initialize() runs.
 */
export interface ThermostatServerInitialState {
  /** Local temperature in 0.01°C units (e.g., 2100 = 21°C). Default: 2100 */
  localTemperature?: number;
  /** Heating setpoint in 0.01°C units (e.g., 2000 = 20°C). Default: 2000 */
  occupiedHeatingSetpoint?: number;
  /** Cooling setpoint in 0.01°C units (e.g., 2400 = 24°C). Default: 2400 */
  occupiedCoolingSetpoint?: number;
  /** Minimum heat setpoint limit. Default: 0 (0°C) */
  minHeatSetpointLimit?: number;
  /** Maximum heat setpoint limit. Default: 5000 (50°C) */
  maxHeatSetpointLimit?: number;
  /** Minimum cool setpoint limit. Default: 0 (0°C) */
  minCoolSetpointLimit?: number;
  /** Maximum cool setpoint limit. Default: 5000 (50°C) */
  maxCoolSetpointLimit?: number;
}

/**
 * Creates a ThermostatServer behavior with the specified config and initial state.
 *
 * CRITICAL: The initialState values are passed DIRECTLY to Matter.js during behavior
 * registration. This is the ONLY way to prevent NaN validation errors, because
 * Matter.js validates setpoints BEFORE our initialize() method runs.
 *
 * Pass ALL thermostat attributes directly to behaviors.require() call.
 *
 * @param config - The thermostat server configuration (getters/setters for HA)
 * @param initialState - Initial attribute values. MUST include valid setpoints!
 */
export function ThermostatServer(
  config: ThermostatServerConfig,
  initialState: ThermostatServerInitialState = {},
  features: ThermostatServerFeatures = { heating: true, cooling: true },
) {
  const supportsHeating = features.heating;
  const supportsCooling = features.cooling;

  if (supportsHeating && supportsCooling) {
    if (features.autoMode) {
      // Full features (heating + cooling + auto mode) for heat_cool devices
      // IMPORTANT: abs limits → regular limits → setpoints to prevent
      // validation failures for negative temperatures (e.g. refrigerators).
      return ThermostatServerBase.set({
        config,
        absMinHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
        absMaxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
        absMinCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
        absMaxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
        minHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
        maxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
        minCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
        maxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
        localTemperature: initialState.localTemperature ?? 2100,
        occupiedHeatingSetpoint: initialState.occupiedHeatingSetpoint ?? 2000,
        occupiedCoolingSetpoint: initialState.occupiedCoolingSetpoint ?? 2400,
        minSetpointDeadBand: 0,
      });
    }

    // Heating + Cooling without AutoMode (for ACs with heat+cool but no heat_cool)
    // Apple Home won't show Auto option, preventing mode flipping issues.
    return HeatingAndCoolingThermostatServerBase.set({
      config,
      absMinHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
      absMaxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
      absMinCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
      absMaxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
      minHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
      maxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
      minCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
      maxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
      localTemperature: initialState.localTemperature ?? 2100,
      occupiedHeatingSetpoint: initialState.occupiedHeatingSetpoint ?? 2000,
      occupiedCoolingSetpoint: initialState.occupiedCoolingSetpoint ?? 2400,
    });
  }

  if (supportsCooling) {
    // Cooling only - no Heating or AutoMode features
    return CoolingOnlyThermostatServerBase.set({
      config,
      absMinCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
      absMaxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
      minCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
      maxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
      localTemperature: initialState.localTemperature ?? 2100,
      occupiedCoolingSetpoint: initialState.occupiedCoolingSetpoint ?? 2400,
    });
  }

  // Heating only (default) - no Cooling or AutoMode features
  return HeatingOnlyThermostatServerBase.set({
    config,
    absMinHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
    absMaxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
    minHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
    maxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
    localTemperature: initialState.localTemperature ?? 2100,
    occupiedHeatingSetpoint: initialState.occupiedHeatingSetpoint ?? 2000,
  });
}
