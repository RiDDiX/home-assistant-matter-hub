import {
  type FanDeviceAttributes,
  FanDeviceDirection,
  FanDeviceFeature,
  type FanWindPresets,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { FanControl } from "@matter/main/clusters";
import { autoPresetName } from "../../../../../utils/converters/fan-mode.js";
import { testBit } from "../../../../../utils/test-bit.js";
import {
  FanControlServer,
  type FanControlServerConfig,
} from "../../../../behaviors/fan-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

const attributes = (e: HomeAssistantEntityState) =>
  e.attributes as FanDeviceAttributes;

// Per-entity wind preset names, falls back to empty.
const windPresets = (agent: Agent): FanWindPresets =>
  agent.get(HomeAssistantEntityBehavior).state.mapping?.fanWindPresets ?? {};

const isEnglishNatural = (m: string) => {
  const lower = m.toLowerCase();
  return lower === "natural" || lower === "nature";
};
const isEnglishSleep = (m: string) => m.toLowerCase() === "sleep";

/**
 * Which wind modes an entity really offers, derived from its preset_modes.
 * Matter's WindSupport is a claim about the device: advertising a mode the
 * entity lacks makes controllers offer it, and Home Assistant then rejects
 * the resulting fan.set_preset_mode call.
 */
export function windSupportFor(
  presetModes: string[] | undefined,
  presets: FanWindPresets,
): { naturalWind: boolean; sleepWind: boolean } {
  const modes = presetModes ?? [];
  return {
    naturalWind: modes.some(
      (m) => isEnglishNatural(m) || !!presets.natural?.includes(m),
    ),
    sleepWind: modes.some(
      (m) => isEnglishSleep(m) || !!presets.sleep?.includes(m),
    ),
  };
}

// Exported for tests.
export const fanControlConfig: FanControlServerConfig = {
  getPercentage: (state) =>
    state.state === "off" ? 0 : attributes(state).percentage,
  getStepSize: (state) => attributes(state).percentage_step,
  getAirflowDirection: (state) =>
    attributes(state).direction === FanDeviceDirection.FORWARD
      ? FanControl.AirflowDirection.Forward
      : attributes(state).direction === FanDeviceDirection.REVERSE
        ? FanControl.AirflowDirection.Reverse
        : FanControl.AirflowDirection.Forward,
  isInAutoMode: (state) =>
    attributes(state).preset_mode?.toLowerCase() === "auto",
  // Preset mode support
  getPresetModes: (state) => attributes(state).preset_modes,
  getCurrentPresetMode: (state) => attributes(state).preset_mode,
  supportsPercentage: (state) =>
    testBit(
      attributes(state).supported_features ?? 0,
      FanDeviceFeature.SET_SPEED,
    ),
  // Rocking (oscillation) support
  isOscillating: (state) => attributes(state).oscillating ?? false,
  supportsOscillation: (state) =>
    testBit(
      attributes(state).supported_features ?? 0,
      FanDeviceFeature.OSCILLATE,
    ),
  // Wind mode support - localized presets via mapping, english as fallback
  getWindMode: (state, agent) => {
    const mode = attributes(state).preset_mode;
    if (!mode) return undefined;
    const presets = windPresets(agent);
    if (presets.natural?.includes(mode)) return "natural";
    if (presets.sleep?.includes(mode)) return "sleep";
    if (isEnglishNatural(mode)) return "natural";
    if (isEnglishSleep(mode)) return "sleep";
    return undefined;
  },
  supportsWind: (state, agent) => {
    const modes = attributes(state).preset_modes ?? [];
    const presets = windPresets(agent);
    return modes.some(
      (m) =>
        isEnglishNatural(m) ||
        isEnglishSleep(m) ||
        !!presets.natural?.includes(m) ||
        !!presets.sleep?.includes(m),
    );
  },
  // Advertise only the wind modes this entity really has (#fan-modes).
  getWindSupport: (state, agent) =>
    windSupportFor(attributes(state).preset_modes, windPresets(agent)),

  turnOff: () => ({ action: "fan.turn_off" }),
  turnOn: (percentage) => ({
    action: "fan.set_percentage",
    data: { percentage },
  }),
  // HA preset names are case-sensitive, so send the entity's own auto preset.
  setAutoMode: (_, agent) => {
    const entityState = agent.get(HomeAssistantEntityBehavior).state.entity
      .state;
    const presetMode =
      autoPresetName(attributes(entityState).preset_modes) ?? "Auto";
    return { action: "fan.turn_on", data: { preset_mode: presetMode } };
  },
  setAirflowDirection: (direction) => ({
    action: "fan.set_direction",
    data: {
      direction:
        direction === FanControl.AirflowDirection.Forward
          ? FanDeviceDirection.FORWARD
          : FanDeviceDirection.REVERSE,
    },
  }),
  setPresetMode: (presetMode) => ({
    action: "fan.set_preset_mode",
    data: { preset_mode: presetMode },
  }),
  setOscillation: (oscillating) => ({
    action: "fan.oscillate",
    data: { oscillating },
  }),
  setWindMode: (mode, agent) => {
    const presets = windPresets(agent);
    const entityState = agent.get(HomeAssistantEntityBehavior).state.entity
      .state;
    const modes = attributes(entityState).preset_modes ?? [];
    // HA preset names are case-sensitive, send the entity's own spelling.
    let presetMode: string;
    if (mode === "natural") {
      presetMode =
        presets.natural?.[0] ?? modes.find(isEnglishNatural) ?? "Natural";
    } else if (mode === "sleep") {
      presetMode = presets.sleep?.[0] ?? modes.find(isEnglishSleep) ?? "Sleep";
    } else {
      // "off" picks the first non-wind, non-auto preset (the normal one, e.g. 直吹风),
      // else Auto, so HA only gets a preset the entity declares
      const wind = new Set([
        ...(presets.natural ?? []),
        ...(presets.sleep ?? []),
      ]);
      const nonWind = modes.filter(
        (m) => !wind.has(m) && !isEnglishNatural(m) && !isEnglishSleep(m),
      );
      presetMode =
        nonWind.find((m) => m.toLowerCase() !== "auto") ??
        nonWind[0] ??
        "Normal";
    }
    return {
      action: "fan.set_preset_mode",
      data: { preset_mode: presetMode },
    };
  },
};

export const FanFanControlServer = FanControlServer(fanControlConfig);
