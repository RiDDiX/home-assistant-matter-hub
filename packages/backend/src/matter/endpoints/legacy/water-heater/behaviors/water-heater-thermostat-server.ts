import type {
  HomeAssistantEntityState,
  WaterHeaterDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { Temperature } from "../../../../../utils/converters/temperature.js";
import {
  ThermostatServer,
  type ThermostatServerConfig,
} from "../../../../behaviors/thermostat-server.js";

const getUnit = (agent: Agent) =>
  agent.env.get(HomeAssistantConfig).unitSystem.temperature;

const attributes = (entity: HomeAssistantEntityState) =>
  entity.attributes as WaterHeaterDeviceAttributes;

const getTemp = (
  agent: Agent,
  entity: HomeAssistantEntityState,
  attributeName: keyof WaterHeaterDeviceAttributes,
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

const config: ThermostatServerConfig = {
  supportsTemperatureRange: () => false,
  getMinTemperature: (entity, agent) => getTemp(agent, entity, "min_temp"),
  getMaxTemperature: (entity, agent) => getTemp(agent, entity, "max_temp"),
  getCurrentTemperature: (entity, agent) =>
    getTemp(agent, entity, "current_temperature"),
  getTargetHeatingTemperature: (entity, agent) =>
    getTemp(agent, entity, "temperature"),
  getTargetCoolingTemperature: (entity, agent) =>
    getTemp(agent, entity, "temperature"),
  getSystemMode: (entity) => {
    const operationMode = attributes(entity).operation_mode;
    if (operationMode === "off") {
      return Thermostat.SystemMode.Off;
    }
    return Thermostat.SystemMode.Heat;
  },
  getRunningMode: (entity) => {
    const operationMode = attributes(entity).operation_mode;
    if (operationMode === "off") {
      return Thermostat.ThermostatRunningMode.Off;
    }
    return Thermostat.ThermostatRunningMode.Heat;
  },
  setSystemMode: (systemMode) => {
    if (systemMode === Thermostat.SystemMode.Off) {
      return {
        action: "water_heater.set_operation_mode",
        data: { operation_mode: "off" },
      };
    }
    return {
      action: "water_heater.turn_on",
      data: {},
    };
  },
  setTargetTemperature: (value, agent) => ({
    action: "water_heater.set_temperature",
    data: {
      temperature: value.toUnit(getUnit(agent)),
    },
  }),
  setTargetTemperatureRange: ({ low }, agent) => ({
    action: "water_heater.set_temperature",
    data: {
      temperature: low.toUnit(getUnit(agent)),
    },
  }),
};

export const WaterHeaterThermostatServer =
  ThermostatServer(config).with("Heating");
