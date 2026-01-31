import type {
  HomeAssistantEntityState,
  HumidiferDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import {
  FanControlServer,
  type FanControlServerConfig,
} from "../../../../behaviors/fan-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

function getHumidityPercent(state: HomeAssistantEntityState): number {
  const { min_humidity, max_humidity, humidity } =
    state.attributes as HumidiferDeviceAttributes;
  if (humidity != null && min_humidity != null && max_humidity != null) {
    const range = max_humidity - min_humidity;
    if (range > 0) {
      return ((humidity - min_humidity) / range) * 100;
    }
  }
  return 0;
}

function setHumidityFromPercent(percent: number, agent: Agent) {
  const { min_humidity, max_humidity } = agent.get(HomeAssistantEntityBehavior)
    .entity.state.attributes as HumidiferDeviceAttributes;
  const range = max_humidity - min_humidity;
  const humidity = Math.round((range * percent) / 100 + min_humidity);
  return {
    action: "humidifier.set_humidity",
    data: { humidity },
  };
}

function isInAutoMode(state: HomeAssistantEntityState): boolean {
  const { mode } = state.attributes as HumidiferDeviceAttributes;
  return mode?.toLowerCase() === "auto";
}

const config: FanControlServerConfig = {
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
  turnOff: () => ({ action: "humidifier.turn_off" }),
  turnOn: (percent: number, agent: Agent) =>
    setHumidityFromPercent(percent, agent),
  setAutoMode: () => ({
    action: "humidifier.set_mode",
    data: { mode: "auto" },
  }),
  setAirflowDirection: () => ({ action: "humidifier.turn_on" }),
  setPresetMode: (mode: string) => ({
    action: "humidifier.set_mode",
    data: { mode },
  }),
};

export const HumidifierFanControlServer = FanControlServer(config).with(
  "MultiSpeed",
  "Step",
);

export const HumidifierFanControlServerWithAuto = FanControlServer(config).with(
  "MultiSpeed",
  "Step",
  "Auto",
);
