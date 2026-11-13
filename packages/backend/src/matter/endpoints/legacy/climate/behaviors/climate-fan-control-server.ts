import type {
  ClimateDeviceAttributes,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { autoPresetName } from "../../../../../utils/converters/fan-mode.js";
import { toAscendingSpeedPresets } from "../../../../../utils/converters/fan-mode-order.js";
import {
  type FanControlRockSetting,
  FanControlServer,
  type FanControlServerConfig,
} from "../../../../behaviors/fan-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

const logger = Logger.get("ClimateFanControlServer");

const attributes = (entity: HomeAssistantEntityState) =>
  entity.attributes as ClimateDeviceAttributes;

export function swingModeToRockSetting(
  mode: string | null | undefined,
): FanControlRockSetting {
  switch (mode?.toLowerCase()) {
    case "both":
      return { rockLeftRight: true, rockUpDown: true };
    case "horizontal":
      return { rockLeftRight: true };
    case "vertical":
      return { rockUpDown: true };
    default:
      return {};
  }
}

export function swingModesToRockSupport(
  modes: string[] | null | undefined,
): FanControlRockSetting {
  const normalized = new Set(modes?.map((mode) => mode.toLowerCase()) ?? []);
  return {
    rockLeftRight:
      normalized.has("horizontal") || normalized.has("both") || undefined,
    rockUpDown:
      normalized.has("vertical") || normalized.has("both") || undefined,
  };
}

export function rockSettingToSwingMode(setting: FanControlRockSetting): string {
  if (setting.rockLeftRight && setting.rockUpDown) {
    return "both";
  }
  if (setting.rockLeftRight) {
    return "horizontal";
  }
  if (setting.rockUpDown) {
    return "vertical";
  }
  return "off";
}

const isOffLikeSwing = (mode: string) =>
  ["off", "stopped", "none"].includes(mode.trim().toLowerCase());

/**
 * The swing mode to send for a Matter rock setting, in the entity's own
 * spelling (HA swing mode names are case-sensitive). Not rocking sends the
 * declared off-like mode. Rocking sends the matching mode, else vertical, else
 * on, else the first non-off mode. Undefined when nothing declared fits.
 * Entities that declare no swing modes keep the historic literals.
 *
 * Exported for tests.
 */
export function climateSwingMode(
  swingModes: string[] | null | undefined,
  setting: FanControlRockSetting,
): string | undefined {
  const wanted = rockSettingToSwingMode(setting);
  const modes = swingModes ?? [];
  if (modes.length === 0) {
    return wanted;
  }
  if (wanted === "off") {
    return modes.find(isOffLikeSwing);
  }
  const declared = (name: string) =>
    modes.find((mode) => mode.toLowerCase() === name);
  return (
    declared(wanted) ??
    declared("vertical") ??
    declared("on") ??
    modes.find((mode) => !isOffLikeSwing(mode))
  );
}

const loggedNoSwingMode = new Set<string>();

/**
 * The fan mode to send when a controller asks for speed zero.
 *
 * Preference order:
 *   1. an off-like mode the entity actually declares, in its own spelling
 *   2. the slowest non-auto speed it declares
 *   3. "off" as a last resort, preserving the historic behaviour for entities
 *      that declare no fan modes at all
 *
 * Exported for tests.
 */
export function climateFanOffMode(
  fanModes: string[] | null | undefined,
): string {
  const modes = fanModes ?? [];
  const declaredOff = modes.find((mode) =>
    ["off", "none", "stop"].includes(mode.trim().toLowerCase()),
  );
  if (declaredOff) {
    return declaredOff;
  }
  const speeds = toAscendingSpeedPresets(
    modes.filter((mode) => mode.toLowerCase() !== "auto"),
  );
  return speeds[0] ?? "off";
}

// Exported for tests.
export const climateFanControlConfig: FanControlServerConfig = {
  getPercentage: () => undefined,
  getStepSize: () => undefined,
  getAirflowDirection: () => undefined,
  isInAutoMode: (entity) => {
    const fanMode = attributes(entity).fan_mode;
    return fanMode?.toLowerCase() === "auto";
  },
  getPresetModes: (entity) => {
    return attributes(entity).fan_modes ?? [];
  },
  getCurrentPresetMode: (entity) => {
    return attributes(entity).fan_mode ?? undefined;
  },
  supportsPercentage: () => false,
  // An AC's fan cannot stop while the compressor runs, so speed zero must not
  // report the unit as powered off. Without this the Matter OnOff cluster flips
  // false at zero, the controller shows the AC off, HA reports it still on, and
  // the tile flaps back. Power stays with the OnOff cluster's own commands.
  syncOnOffWithSpeed: false,
  isOscillating: (entity) => {
    const mode = attributes(entity).swing_mode;
    return mode != null && !isOffLikeSwing(mode);
  },
  supportsOscillation: (entity) =>
    (attributes(entity).swing_modes?.length ?? 0) > 0,
  getRockSetting: (entity) => {
    const mode = attributes(entity).swing_mode;
    const setting = swingModeToRockSetting(mode);
    // Any declared mode that is not off-like rocks, e.g. a plain "on".
    if (
      mode != null &&
      !isOffLikeSwing(mode) &&
      !setting.rockLeftRight &&
      !setting.rockUpDown
    ) {
      return { rockUpDown: true };
    }
    return setting;
  },
  // Climate devices don't typically support wind modes
  getWindMode: () => undefined,
  supportsWind: () => false,

  // A controller writing percentSetting 0 lands here. An air conditioner's fan
  // cannot stop independently of the compressor, and HA climate entities almost
  // never declare an "off" fan mode - sending the literal "off" just fails the
  // service call, so the slider's bottom position silently does nothing.
  // Clamp to the slowest real speed instead, unless the entity genuinely offers
  // an off-like mode, in which case use its own spelling (HA fan mode names are
  // case-sensitive). Power stays with the OnOff cluster, which is where a
  // controller's actual "off" belongs.
  turnOff: (_, agent) => {
    const entityState = agent.get(HomeAssistantEntityBehavior).state.entity
      .state;
    const fanMode = climateFanOffMode(attributes(entityState).fan_modes);
    return {
      action: "climate.set_fan_mode",
      data: { fan_mode: fanMode },
    };
  },
  turnOn: () => ({
    action: "climate.set_fan_mode",
    data: { fan_mode: "on" },
  }),
  // HA fan mode names are case-sensitive, send the entity's own auto mode.
  setAutoMode: (_, agent) => {
    const entityState = agent.get(HomeAssistantEntityBehavior).state.entity
      .state;
    const fanMode =
      autoPresetName(attributes(entityState).fan_modes ?? undefined) ?? "auto";
    return {
      action: "climate.set_fan_mode",
      data: { fan_mode: fanMode },
    };
  },
  setAirflowDirection: () => ({
    action: "homeassistant.turn_on",
  }),
  setPresetMode: (presetMode) => ({
    action: "climate.set_fan_mode",
    data: { fan_mode: presetMode },
  }),
  setOscillation: (oscillating) => ({
    action: "climate.set_swing_mode",
    data: { swing_mode: oscillating ? "vertical" : "off" },
  }),
  setRockSetting: (setting, agent) => {
    const entityState = agent.get(HomeAssistantEntityBehavior).state.entity
      .state;
    const swingMode = climateSwingMode(
      attributes(entityState).swing_modes,
      setting,
    );
    if (swingMode === undefined) {
      if (!loggedNoSwingMode.has(entityState.entity_id)) {
        loggedNoSwingMode.add(entityState.entity_id);
        logger.debug(
          `[${entityState.entity_id}] no swing mode for rock setting ${JSON.stringify(setting)} in ${JSON.stringify(attributes(entityState).swing_modes)}, not sent`,
        );
      }
      return undefined;
    }
    return {
      action: "climate.set_swing_mode",
      data: { swing_mode: swingMode },
    };
  },
  setWindMode: () => ({
    action: "homeassistant.turn_on",
  }),
};

const baseFeatures: ("MultiSpeed" | "Step")[] = ["MultiSpeed", "Step"];

/** True when the climate entity declares an "auto" fan mode. */
export function climateSupportsAutoFanMode(
  fanModes: string[] | null | undefined,
): boolean {
  return autoPresetName(fanModes ?? undefined) !== undefined;
}

export function ClimateFanControlServer(
  rockSupport: FanControlRockSetting | undefined,
  supportsAutoFanMode = true,
) {
  return FanControlServer(climateFanControlConfig, {
    rockSupport: rockSupport ?? { rockUpDown: true },
    auto: supportsAutoFanMode,
  }).with(
    ...baseFeatures,
    ...(supportsAutoFanMode ? (["Auto"] as const) : []),
    ...(rockSupport ? (["Rocking"] as const) : []),
  );
}
