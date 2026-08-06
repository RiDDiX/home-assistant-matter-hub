import {
  type ClimateAutoMode,
  type ClimateDeviceAttributes,
  ClimateDeviceFeature,
  ClimateHvacAction,
  ClimateHvacMode,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { snapToStep } from "../../../../../utils/converters/snap-to-step.js";
import { Temperature } from "../../../../../utils/converters/temperature.js";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  ThermostatServer,
  type ThermostatServerConfig,
  type ThermostatServerFeatures,
  type ThermostatServerInitialState,
} from "../../../../behaviors/thermostat-server.js";

const getUnit = (agent: Agent) =>
  agent.env.get(HomeAssistantConfig).unitSystem.temperature;
const attributes = (entity: HomeAssistantEntityState) =>
  <ClimateDeviceAttributes>entity.attributes;
const getTemp = (
  agent: Agent,
  entity: HomeAssistantEntityState,
  attributeName: keyof ClimateDeviceAttributes,
) => {
  const temperature = attributes(entity)[attributeName] as
    | string
    | number
    | null
    | undefined;
  const unit = getUnit(agent);
  if (temperature != null) {
    return Temperature.withUnit(+temperature, unit);
  }
};

const getStep = (entity: HomeAssistantEntityState): number | undefined => {
  const raw = attributes(entity).target_temp_step;
  if (raw == null) return undefined;
  const num = typeof raw === "string" ? parseFloat(raw) : raw;
  return Number.isFinite(num) && num > 0 ? num : undefined;
};

const getRefTemp = (
  entity: HomeAssistantEntityState,
  attr: keyof ClimateDeviceAttributes,
): number | undefined => {
  const raw = attributes(entity)[attr];
  if (raw == null) return undefined;
  const num = typeof raw === "string" ? parseFloat(raw) : (raw as number);
  return Number.isFinite(num) ? num : undefined;
};

const systemModeToHvacMode: Record<Thermostat.SystemMode, ClimateHvacMode> = {
  [Thermostat.SystemMode.Auto]: ClimateHvacMode.heat_cool,
  [Thermostat.SystemMode.Precooling]: ClimateHvacMode.cool,
  [Thermostat.SystemMode.Cool]: ClimateHvacMode.cool,
  [Thermostat.SystemMode.Heat]: ClimateHvacMode.heat,
  [Thermostat.SystemMode.EmergencyHeat]: ClimateHvacMode.heat,
  [Thermostat.SystemMode.FanOnly]: ClimateHvacMode.fan_only,
  [Thermostat.SystemMode.Dry]: ClimateHvacMode.dry,
  [Thermostat.SystemMode.Sleep]: ClimateHvacMode.off,
  [Thermostat.SystemMode.Off]: ClimateHvacMode.off,
};
export const hvacActionToRunningMode: Record<
  ClimateHvacAction,
  Thermostat.ThermostatRunningMode
> = {
  [ClimateHvacAction.preheating]: Thermostat.ThermostatRunningMode.Heat,
  [ClimateHvacAction.defrosting]: Thermostat.ThermostatRunningMode.Heat,
  [ClimateHvacAction.heating]: Thermostat.ThermostatRunningMode.Heat,
  // Drying has no dedicated Matter RunningMode; reporting Heat made Apple
  // Home display "Heating to …" during dehumidification. Off is neutral and
  // getRunningState() downgrades it to FanOnly/Dry via systemMode.
  [ClimateHvacAction.drying]: Thermostat.ThermostatRunningMode.Off,
  [ClimateHvacAction.cooling]: Thermostat.ThermostatRunningMode.Cool,
  [ClimateHvacAction.fan]: Thermostat.ThermostatRunningMode.Off,
  [ClimateHvacAction.idle]: Thermostat.ThermostatRunningMode.Off,
  [ClimateHvacAction.off]: Thermostat.ThermostatRunningMode.Off,
};

// Pure derivation of the Matter ThermostatRunningMode from HA hvac_action.
// Exported for characterization tests; the thermostat config delegates here.
// Returns Off when hvac_action is absent, which is exactly the IR/SmartIR case
// in #309 where the controller then guesses heat/cool from the setpoints.
export function getRunningModeFromHvacAction(
  entity: HomeAssistantEntityState,
): Thermostat.ThermostatRunningMode {
  const action = attributes(entity).hvac_action;
  if (!action) {
    return Thermostat.ThermostatRunningMode.Off;
  }
  return (
    hvacActionToRunningMode[action] ?? Thermostat.ThermostatRunningMode.Off
  );
}

export function pinnedAutoSystemMode(
  override: ClimateAutoMode | undefined,
): Thermostat.SystemMode | undefined {
  if (override === "cool") {
    return Thermostat.SystemMode.Cool;
  }
  if (override === "heat") {
    return Thermostat.SystemMode.Heat;
  }
  return undefined;
}

const hvacModeToSystemMode: Record<ClimateHvacMode, Thermostat.SystemMode> = {
  [ClimateHvacMode.heat]: Thermostat.SystemMode.Heat,
  [ClimateHvacMode.cool]: Thermostat.SystemMode.Cool,
  [ClimateHvacMode.auto]: Thermostat.SystemMode.Auto,
  [ClimateHvacMode.heat_cool]: Thermostat.SystemMode.Auto,
  [ClimateHvacMode.dry]: Thermostat.SystemMode.Dry,
  [ClimateHvacMode.fan_only]: Thermostat.SystemMode.FanOnly,
  [ClimateHvacMode.off]: Thermostat.SystemMode.Off,
};

/**
 * Detect heat_cool-only zones: entities that have heat_cool but no explicit
 * heat or cool mode. These zones follow the main system and can't independently
 * switch between heating and cooling. Per Matter spec, they SHOULD report
 * CoolingOnly or HeatingOnly based on the current capability.
 */
function isHeatCoolOnly(modes: ClimateHvacMode[]): boolean {
  return (
    modes.includes(ClimateHvacMode.heat_cool) &&
    !modes.includes(ClimateHvacMode.heat) &&
    !modes.includes(ClimateHvacMode.cool)
  );
}

/**
 * Track last known active HVAC direction for heat_cool-only zones.
 * When idle, hvac_action doesn't reveal the main system's mode,
 * so we remember the last active direction to avoid mode flipping.
 */
const lastHvacDirection = new Map<string, "heating" | "cooling">();

// climateKeepModeOnIdle (#340): arm on non-Off, clear only after two consecutive
// hvac_action=off events so the brief off+off HA emits before off+idle (internal
// cleaning) doesn't drop the freeze on the cool->off+idle path.
interface ClimateFreezeState {
  lastNonOffMode: Thermostat.SystemMode;
  pending: boolean;
  confirmedOff: boolean;
}
export const climateFreezeState = new Map<string, ClimateFreezeState>();

function getHeatCoolOnlyDirection(
  entity: HomeAssistantEntityState,
  agent: Agent,
): "heating" | "cooling" {
  const action = attributes(entity).hvac_action;
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const entityId = homeAssistant.entityId;

  if (
    action === ClimateHvacAction.heating ||
    action === ClimateHvacAction.preheating ||
    action === ClimateHvacAction.defrosting ||
    action === ClimateHvacAction.drying
  ) {
    lastHvacDirection.set(entityId, "heating");
    return "heating";
  }
  if (action === ClimateHvacAction.cooling) {
    lastHvacDirection.set(entityId, "cooling");
    return "cooling";
  }
  // idle/off/fan: use last known direction, default to heating
  return lastHvacDirection.get(entityId) ?? "heating";
}

function computeSystemMode(
  entity: HomeAssistantEntityState,
  agent: Agent,
): Thermostat.SystemMode {
  const hvacMode = entity.state as ClimateHvacMode;
  const systemMode =
    hvacModeToSystemMode[hvacMode] ?? Thermostat.SystemMode.Off;
  // Map SystemMode.Auto to the correct mode based on device capabilities.
  // Matter AutoMode = dual setpoint = HA heat_cool.
  // HA auto ≠ Matter Auto, it's a single-setpoint mode where the device decides.
  if (systemMode === Thermostat.SystemMode.Auto) {
    const modes = attributes(entity).hvac_modes ?? [];

    // heat_cool-only zones: dynamically switch between Heat and Cool
    // based on hvac_action to reflect the main system's mode (#207).
    if (isHeatCoolOnly(modes)) {
      const direction = getHeatCoolOnlyDirection(entity, agent);
      return direction === "cooling"
        ? Thermostat.SystemMode.Cool
        : Thermostat.SystemMode.Heat;
    }

    // Mirror the autoMode flag in climate/index.ts: AutoMode is only safe
    // when HA exposes heat_cool (dual setpoint) alongside explicit heat or
    // cool. HA-auto-only devices fall through to dynamic Cool/Heat below
    // because Apple Home's Auto tile doesn't write SystemMode.Auto for them
    // (#309). #319: returning Auto on a non-AutoMode base throws
    // ConformanceError, so the heat_cool guard also keeps us conformant.
    const hasMatterAuto =
      modes.includes(ClimateHvacMode.heat_cool) &&
      (modes.includes(ClimateHvacMode.heat) ||
        modes.includes(ClimateHvacMode.cool));
    if (hasMatterAuto) {
      return systemMode;
    }

    // No heat_cool: map HA auto → Heat/Cool based on device capabilities or action
    const hasCooling = modes.some((m) => m === ClimateHvacMode.cool);
    const hasHeating = modes.some(
      (m) => m === ClimateHvacMode.heat || m === ClimateHvacMode.auto,
    );
    if (hasHeating && !hasCooling) {
      return Thermostat.SystemMode.Heat;
    }
    if (hasCooling && !hasHeating) {
      return Thermostat.SystemMode.Cool;
    }
    // Both heat and cool but no heat_cool: HA `auto` is single-setpoint and
    // doesn't tell us which direction is active. Use hvac_action when
    // present, fall back to the last direction we saw for this entity, then
    // seed from current vs target so Apple Home doesn't flip Cool↔Heat
    // every time the AC reaches its setpoint and hvac_action goes idle.
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;
    const pinnedMode = pinnedAutoSystemMode(
      homeAssistant.state.mapping?.climateAutoMode,
    );
    if (pinnedMode != null) {
      lastHvacDirection.set(
        entityId,
        pinnedMode === Thermostat.SystemMode.Cool ? "cooling" : "heating",
      );
      return pinnedMode;
    }
    const action = attributes(entity).hvac_action;
    if (action === ClimateHvacAction.cooling) {
      lastHvacDirection.set(entityId, "cooling");
      return Thermostat.SystemMode.Cool;
    }
    if (action === ClimateHvacAction.heating) {
      lastHvacDirection.set(entityId, "heating");
      return Thermostat.SystemMode.Heat;
    }
    const remembered = lastHvacDirection.get(entityId);
    if (remembered) {
      return remembered === "cooling"
        ? Thermostat.SystemMode.Cool
        : Thermostat.SystemMode.Heat;
    }
    const current = attributes(entity).current_temperature;
    const target = attributes(entity).temperature;
    if (typeof current === "number" && typeof target === "number") {
      if (current > target) {
        lastHvacDirection.set(entityId, "cooling");
        return Thermostat.SystemMode.Cool;
      }
      if (current < target) {
        lastHvacDirection.set(entityId, "heating");
        return Thermostat.SystemMode.Heat;
      }
    }
    return Thermostat.SystemMode.Cool;
  }
  return systemMode;
}

export function applyClimateFreezeForKeepModeOnIdle(
  computed: Thermostat.SystemMode,
  entity: HomeAssistantEntityState,
  entityId: string,
  keepModeOnIdle: boolean,
): Thermostat.SystemMode {
  if (computed !== Thermostat.SystemMode.Off) {
    const existing = climateFreezeState.get(entityId);
    if (existing) {
      existing.lastNonOffMode = computed;
      existing.pending = true;
      existing.confirmedOff = false;
    } else {
      climateFreezeState.set(entityId, {
        lastNonOffMode: computed,
        pending: true,
        confirmedOff: false,
      });
    }
    return computed;
  }

  const action = attributes(entity).hvac_action;
  const existing = climateFreezeState.get(entityId);
  if (action === ClimateHvacAction.off) {
    if (existing) {
      if (existing.confirmedOff) {
        existing.pending = false;
        existing.confirmedOff = false;
      } else {
        existing.confirmedOff = true;
      }
    }
  } else if (existing) {
    existing.confirmedOff = false;
  }

  if (keepModeOnIdle && existing?.pending) {
    return existing.lastNonOffMode;
  }
  return computed;
}

// Temperature range (target_temp_low/high) only works in heat_cool mode.
// In heat or cool mode, HA expects a single "temperature" value.
// We must check BOTH the feature flag AND the current HVAC mode.
export function isTemperatureRangeActive(
  entity: HomeAssistantEntityState,
): boolean {
  const hasFeature = testBit(
    entity.attributes.supported_features ?? 0,
    ClimateDeviceFeature.TARGET_TEMPERATURE_RANGE,
  );
  const currentMode = entity.state as ClimateHvacMode;
  const isRangeMode =
    currentMode === ClimateHvacMode.heat_cool ||
    currentMode === ClimateHvacMode.auto;
  return hasFeature && isRangeMode;
}

const config: ThermostatServerConfig = {
  supportsTemperatureRange: isTemperatureRangeActive,
  getMinTemperature: (entity, agent) => getTemp(agent, entity, "min_temp"),
  getMaxTemperature: (entity, agent) => getTemp(agent, entity, "max_temp"),
  getCurrentTemperature: (entity, agent) =>
    getTemp(agent, entity, "current_temperature"),
  // Outside range mode the range attributes are stale: an integration can park
  // target_temp_low/high while the mode it actually runs on is "temperature".
  // Reading them then reports the parked value as the setpoint (#435).
  getTargetHeatingTemperature: (entity, agent) =>
    isTemperatureRangeActive(entity)
      ? (getTemp(agent, entity, "target_temp_low") ??
        getTemp(agent, entity, "target_temperature") ??
        getTemp(agent, entity, "temperature"))
      : (getTemp(agent, entity, "temperature") ??
        getTemp(agent, entity, "target_temperature") ??
        getTemp(agent, entity, "target_temp_low")),
  getTargetCoolingTemperature: (entity, agent) =>
    isTemperatureRangeActive(entity)
      ? (getTemp(agent, entity, "target_temp_high") ??
        getTemp(agent, entity, "target_temperature") ??
        getTemp(agent, entity, "temperature"))
      : (getTemp(agent, entity, "temperature") ??
        getTemp(agent, entity, "target_temperature") ??
        getTemp(agent, entity, "target_temp_high")),
  getSystemMode: (entity, agent) => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const computed = computeSystemMode(entity, agent);
    return applyClimateFreezeForKeepModeOnIdle(
      computed,
      entity,
      homeAssistant.entityId,
      homeAssistant.state.mapping?.climateKeepModeOnIdle === true,
    );
  },
  getRunningMode: (entity) => getRunningModeFromHvacAction(entity),
  getControlSequence: (entity, agent) => {
    const modes = attributes(entity).hvac_modes ?? [];

    // heat_cool-only zones: dynamically report HeatingOnly or CoolingOnly
    // based on hvac_action to reflect the main system's current mode (#207).
    if (isHeatCoolOnly(modes)) {
      const direction = getHeatCoolOnlyDirection(entity, agent);
      return direction === "cooling"
        ? Thermostat.ControlSequenceOfOperation.CoolingOnly
        : Thermostat.ControlSequenceOfOperation.HeatingOnly;
    }

    const hasCooling = modes.some(
      (m) => m === ClimateHvacMode.cool || m === ClimateHvacMode.heat_cool,
    );
    const hasHeating = modes.some(
      (m) => m === ClimateHvacMode.heat || m === ClimateHvacMode.heat_cool,
    );
    if (hasCooling && hasHeating) {
      // CoolingAndHeating only for devices with AutoMode (heat_cool + explicit
      // heat or cool). Devices like SmartIR ACs with auto+cool but no explicit
      // heat get dynamic CoolingOnly/HeatingOnly to avoid conformance errors
      // and match the Matter spec for non-independent-switching devices (#28).
      const hasAutoMode =
        modes.includes(ClimateHvacMode.heat_cool) &&
        (modes.includes(ClimateHvacMode.heat) ||
          modes.includes(ClimateHvacMode.cool));
      if (hasAutoMode) {
        return Thermostat.ControlSequenceOfOperation.CoolingAndHeating;
      }
      // Explicit heat+cool without heat_cool: also safe for CoolingAndHeating
      if (
        modes.includes(ClimateHvacMode.heat) &&
        modes.includes(ClimateHvacMode.cool)
      ) {
        return Thermostat.ControlSequenceOfOperation.CoolingAndHeating;
      }
      // Non-explicit: determine from current mode/action
      const hvacMode = entity.state as ClimateHvacMode;
      if (hvacMode === ClimateHvacMode.cool) {
        return Thermostat.ControlSequenceOfOperation.CoolingOnly;
      }
      if (hvacMode === ClimateHvacMode.heat) {
        return Thermostat.ControlSequenceOfOperation.HeatingOnly;
      }
      const direction = getHeatCoolOnlyDirection(entity, agent);
      return direction === "cooling"
        ? Thermostat.ControlSequenceOfOperation.CoolingOnly
        : Thermostat.ControlSequenceOfOperation.HeatingOnly;
    }
    if (hasCooling) {
      return Thermostat.ControlSequenceOfOperation.CoolingOnly;
    }
    return Thermostat.ControlSequenceOfOperation.HeatingOnly;
  },
  setSystemMode: (systemMode, agent) => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const hvacModes = attributes(homeAssistant.entity.state).hvac_modes ?? [];
    let targetMode = systemModeToHvacMode[systemMode] ?? ClimateHvacMode.off;

    // heat_cool-only zones: map any non-Off mode back to heat_cool
    // since the zone can't independently switch between heat and cool.
    if (isHeatCoolOnly(hvacModes) && systemMode !== Thermostat.SystemMode.Off) {
      targetMode = ClimateHvacMode.heat_cool;
    } else if (systemMode === Thermostat.SystemMode.Auto) {
      // Handle Auto mode: prefer 'auto' if explicitly available, otherwise use 'heat_cool' (default)
      if (hvacModes.includes(ClimateHvacMode.auto)) {
        targetMode = ClimateHvacMode.auto;
      }
      // Otherwise keep heat_cool from the static mapping
    }

    return {
      action: "climate.set_hvac_mode",
      data: { hvac_mode: targetMode },
    };
  },
  setTargetTemperature: (value, agent) => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const entity = homeAssistant.entity.state;
    const unit = getUnit(agent);
    const target = value.toUnit(unit);
    const step = getStep(entity);
    const current =
      getRefTemp(entity, "temperature") ??
      getRefTemp(entity, "target_temperature");
    return {
      action: "climate.set_temperature",
      data: {
        temperature: snapToStep(target, current, step),
      },
    };
  },
  setTargetTemperatureRange: ({ low, high }, agent) => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const entity = homeAssistant.entity.state;
    const unit = getUnit(agent);
    const step = getStep(entity);
    const lowTarget = low.toUnit(unit);
    const highTarget = high.toUnit(unit);
    const lowCurrent =
      getRefTemp(entity, "target_temp_low") ??
      getRefTemp(entity, "temperature");
    const highCurrent =
      getRefTemp(entity, "target_temp_high") ??
      getRefTemp(entity, "temperature");
    return {
      action: "climate.set_temperature",
      data: {
        target_temp_low: snapToStep(lowTarget, lowCurrent, step),
        target_temp_high: snapToStep(highTarget, highCurrent, step),
      },
    };
  },
};
/**
 * Creates a ClimateThermostatServer with the specified initial state.
 *
 * CRITICAL: The initial state values are passed DIRECTLY to Matter.js during
 * behavior registration. This prevents NaN validation errors because Matter.js
 * validates setpoints BEFORE our initialize() method runs.
 *
 * Pass ALL thermostat attributes during registration.
 *
 * @param initialState - Initial attribute values (temperature, setpoints, limits)
 */
export function ClimateThermostatServer(
  initialState: ThermostatServerInitialState = {},
  features?: ThermostatServerFeatures,
) {
  return ThermostatServer(config, initialState, features);
}
