import type {
  ClimateDeviceAttributes,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { autoPresetName } from "../../../../../utils/converters/fan-mode.js";
import { toAscendingSpeedPresets } from "../../../../../utils/converters/fan-mode-order.js";
import {
  type FanControlRockSetting,
  FanControlServer,
  type FanControlServerConfig,
} from "../../../../behaviors/fan-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

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
  isOscillating: (entity) =>
    attributes(entity).swing_mode?.toLowerCase() !== "off" &&
    attributes(entity).swing_mode != null,
  supportsOscillation: (entity) =>
    (attributes(entity).swing_modes?.length ?? 0) > 0,
  getRockSetting: (entity) =>
    swingModeToRockSetting(attributes(entity).swing_mode),
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
  setRockSetting: (setting) => ({
    action: "climate.set_swing_mode",
    data: { swing_mode: rockSettingToSwingMode(setting) },
  }),
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
