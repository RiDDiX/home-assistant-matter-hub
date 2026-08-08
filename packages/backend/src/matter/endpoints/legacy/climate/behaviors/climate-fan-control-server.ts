import type {
  ClimateDeviceAttributes,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { autoPresetName } from "../../../../../utils/converters/fan-mode.js";
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

  turnOff: () => ({
    action: "climate.set_fan_mode",
    data: { fan_mode: "off" },
  }),
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
