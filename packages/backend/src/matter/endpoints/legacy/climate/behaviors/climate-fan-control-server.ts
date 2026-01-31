import type {
  ClimateDeviceAttributes,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import {
  FanControlServer,
  type FanControlServerConfig,
} from "../../../../behaviors/fan-control-server.js";

const attributes = (entity: HomeAssistantEntityState) =>
  entity.attributes as ClimateDeviceAttributes;

const config: FanControlServerConfig = {
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

  turnOff: () => ({
    action: "climate.set_fan_mode",
    data: { fan_mode: "off" },
  }),
  turnOn: () => ({
    action: "climate.set_fan_mode",
    data: { fan_mode: "on" },
  }),
  setAutoMode: () => ({
    action: "climate.set_fan_mode",
    data: { fan_mode: "auto" },
  }),
  setAirflowDirection: () => ({
    action: "homeassistant.turn_on",
  }),
  setPresetMode: (presetMode) => ({
    action: "climate.set_fan_mode",
    data: { fan_mode: presetMode },
  }),
};

const features: ("MultiSpeed" | "Step" | "Auto")[] = [
  "MultiSpeed",
  "Step",
  "Auto",
];

export const ClimateFanControlServer = FanControlServer(config).with(
  ...features,
);
