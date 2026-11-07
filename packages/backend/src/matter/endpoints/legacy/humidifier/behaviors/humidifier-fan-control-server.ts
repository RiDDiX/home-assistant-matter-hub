import type {
  HomeAssistantEntityState,
  HumidiferDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { autoPresetName } from "../../../../../utils/converters/fan-mode.js";
import {
  FanControlServer,
  type FanControlServerConfig,
} from "../../../../behaviors/fan-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

function getHumidityPercent(state: HomeAssistantEntityState): number {
  // The humidity attribute is the TARGET humidity (e.g., 60 means 60%).
  // HA keeps it while off, but a speed with OnOff false leaves Apple on
  // "Turning off..." (#219), so off reads 0.
  if (state.state === "off") {
    return 0;
  }
  const { humidity } = state.attributes as HumidiferDeviceAttributes;
  return humidity ?? 0;
}

function setHumidityFromPercent(percent: number, agent: Agent) {
  const entityState = agent.get(HomeAssistantEntityBehavior).state.entity.state;
  // Off reads 0, so Apple's power-on injects 100. Turn on and let HA keep the
  // stored target instead of jumping it to max (#387).
  if (entityState.state === "off" && Math.round(percent) >= 100) {
    return { action: "humidifier.turn_on" };
  }
  // The percent is the target humidity, kept inside the entity's range so HA
  // accepts it.
  const { min_humidity, max_humidity } =
    entityState.attributes as HumidiferDeviceAttributes;
  return {
    action: "humidifier.set_humidity",
    data: {
      humidity: Math.min(
        max_humidity ?? 100,
        Math.max(min_humidity ?? 0, Math.round(percent)),
      ),
    },
  };
}

function isInAutoMode(state: HomeAssistantEntityState): boolean {
  const { mode } = state.attributes as HumidiferDeviceAttributes;
  return mode?.toLowerCase() === "auto";
}

// Exported for tests.
export const humidifierFanControlConfig: FanControlServerConfig = {
  getPercentage: (state: HomeAssistantEntityState) => getHumidityPercent(state),
  getStepSize: () => undefined,
  getAirflowDirection: () => undefined,
  isInAutoMode: (state: HomeAssistantEntityState) => isInAutoMode(state),
  getPresetModes: (state: HomeAssistantEntityState) => {
    const { available_modes } = state.attributes as HumidiferDeviceAttributes;
    return available_modes;
  },
  getCurrentPresetMode: (state: HomeAssistantEntityState) => {
    const { mode } = state.attributes as HumidiferDeviceAttributes;
    return mode;
  },
  supportsPercentage: () => true,
  // Humidifiers don't typically support oscillation
  isOscillating: () => false,
  supportsOscillation: () => false,
  // Humidifiers don't typically support wind modes
  getWindMode: () => undefined,
  supportsWind: () => false,

  turnOff: () => ({ action: "humidifier.turn_off" }),
  turnOn: (percent: number, agent: Agent) =>
    setHumidityFromPercent(percent, agent),
  // HA mode names are case-sensitive, send the entity's own auto mode.
  setAutoMode: (_, agent) => {
    const entityState = agent.get(HomeAssistantEntityBehavior).state.entity
      .state;
    const { available_modes } =
      entityState.attributes as HumidiferDeviceAttributes;
    return {
      action: "humidifier.set_mode",
      data: { mode: autoPresetName(available_modes) ?? "auto" },
    };
  },
  setAirflowDirection: () => ({ action: "humidifier.turn_on" }),
  setPresetMode: (mode: string) => ({
    action: "humidifier.set_mode",
    data: { mode },
  }),
  setOscillation: () => ({ action: "humidifier.turn_on" }),
  setWindMode: () => ({ action: "humidifier.turn_on" }),
};

export const HumidifierFanControlServer = FanControlServer(
  humidifierFanControlConfig,
).with("MultiSpeed", "Step");

export const HumidifierFanControlServerWithAuto = FanControlServer(
  humidifierFanControlConfig,
).with("MultiSpeed", "Step", "Auto");
