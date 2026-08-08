import {
  type ClimateDeviceAttributes,
  ClimateHvacMode,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { HomeAssistantAction } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { autoPresetName } from "../../../../../utils/converters/fan-mode.js";
import {
  FanControlServer,
  type FanControlServerConfig,
} from "../../../../behaviors/fan-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { OnOffServer } from "../../../../behaviors/on-off-server.js";

const attributes = (entity: HomeAssistantEntityState) =>
  entity.attributes as ClimateDeviceAttributes;

/**
 * Action sent when the companion Fan is switched off. The Fan tile only drives
 * the AC fan_only operation, so turning it off stops the AC instead of forcing
 * a cooling or heating mode (#309). Cool and heat stay on the thermostat tile.
 * Exported for tests.
 */
export function fanOffAction(): HomeAssistantAction {
  return { action: "climate.turn_off" };
}

/** The companion Fan reads on only while the AC is in fan_only. Exported for tests. */
export function isFanOnly(state: HomeAssistantEntityState): boolean {
  return state.state === ClimateHvacMode.fan_only;
}

// Exported for tests.
export const companionFanControlConfig: FanControlServerConfig = {
  getPercentage: () => undefined,
  getStepSize: () => undefined,
  getAirflowDirection: () => undefined,
  isInAutoMode: (entity) =>
    attributes(entity).fan_mode?.toLowerCase() === "auto",
  getPresetModes: (entity) => attributes(entity).fan_modes ?? [],
  // Only report a current speed while in fan_only, so the Fan tile reads off
  // while the AC heats or cools and the two tiles do not contradict.
  getCurrentPresetMode: (entity) =>
    isFanOnly(entity) ? (attributes(entity).fan_mode ?? undefined) : undefined,
  supportsPercentage: () => false,
  // Swing stays on the AC tile; do not duplicate oscillation here.
  isOscillating: () => false,
  supportsOscillation: () => false,
  getWindMode: () => undefined,
  supportsWind: () => false,

  // Fan on/off (including speed-zero) mirrors the OnOff cluster below:
  // on => fan_only, off => climate.turn_off so the Fan tile stops the AC.
  turnOff: () => fanOffAction(),
  turnOn: () => ({
    action: "climate.set_hvac_mode",
    data: { hvac_mode: ClimateHvacMode.fan_only },
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
  setAirflowDirection: () => ({ action: "homeassistant.turn_on" }),
  // Speed change: set the AC fan_mode without leaving fan_only.
  setPresetMode: (presetMode) => ({
    action: "climate.set_fan_mode",
    data: { fan_mode: presetMode },
  }),
  setOscillation: () => ({ action: "homeassistant.turn_on" }),
  setWindMode: () => ({ action: "homeassistant.turn_on" }),
};

// OnOff cluster owns the fan_only operation (the actual reporter intent in
// #309): on => climate.set_hvac_mode fan_only, off => climate.turn_off.
export const ClimateCompanionFanOnOffServer = OnOffServer({
  isOn: (entity) => isFanOnly(entity),
  turnOn: () => ({
    action: "climate.set_hvac_mode",
    data: { hvac_mode: ClimateHvacMode.fan_only },
  }),
  turnOff: () => fanOffAction(),
});

const baseFeatures: ("MultiSpeed" | "Step")[] = ["MultiSpeed", "Step"];

export function ClimateCompanionFanControlServer(supportsAutoFanMode = true) {
  return FanControlServer(companionFanControlConfig, {
    auto: supportsAutoFanMode,
  }).with(...baseFeatures, ...(supportsAutoFanMode ? (["Auto"] as const) : []));
}
