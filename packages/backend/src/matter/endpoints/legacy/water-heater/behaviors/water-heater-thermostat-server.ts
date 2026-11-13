import type {
  HomeAssistantEntityState,
  WaterHeaterDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { Temperature } from "../../../../../utils/converters/temperature.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  ThermostatServer,
  type ThermostatServerConfig,
} from "../../../../behaviors/thermostat-server.js";
import {
  buildModeMapping,
  isOffMode,
  OFF_MODE,
} from "../water-heater-modes.js";

const getUnit = (agent: Agent) =>
  agent.env.get(HomeAssistantConfig).unitSystem.temperature;

const attributes = (entity: HomeAssistantEntityState) =>
  entity.attributes as WaterHeaterDeviceAttributes;

// Same Off reading as the WaterHeaterMode cluster: HA state or operation_mode,
// in any casing.
const isOff = (entity: HomeAssistantEntityState) =>
  isOffMode(entity.state) || isOffMode(attributes(entity).operation_mode ?? "");

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
  getSystemMode: (entity) =>
    isOff(entity) ? Thermostat.SystemMode.Off : Thermostat.SystemMode.Heat,
  getRunningMode: (entity) =>
    isOff(entity)
      ? Thermostat.ThermostatRunningMode.Off
      : Thermostat.ThermostatRunningMode.Heat,
  getControlSequence: () => Thermostat.ControlSequenceOfOperation.HeatingOnly,
  setSystemMode: (systemMode, agent) => {
    if (systemMode === Thermostat.SystemMode.Off) {
      // HA rejects an operation_mode that is not in operation_list.
      const off = buildModeMapping(
        attributes(agent.get(HomeAssistantEntityBehavior).entity.state),
      ).haOperationModes[OFF_MODE];
      return off != null
        ? {
            action: "water_heater.set_operation_mode",
            data: { operation_mode: off },
          }
        : { action: "water_heater.turn_off", data: {} };
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

// Water heaters (kettles, boilers) typically operate at 70-100°C
// We need higher limits than the default 0-50°C range
const waterHeaterInitialState = {
  localTemperature: 2100, // 21°C default
  occupiedHeatingSetpoint: 10000, // 100°C default for water heaters
  minHeatSetpointLimit: 0, // 0°C
  maxHeatSetpointLimit: 12000, // 120°C - allows for boiling water + margin
  // Also set absolute limits for water heaters
  absMinHeatSetpointLimit: 0,
  absMaxHeatSetpointLimit: 12000,
};

// Water heater uses heating-only features so controllers correctly identify
// it as a single-setpoint heating device.
export const WaterHeaterThermostatServer = ThermostatServer(
  config,
  waterHeaterInitialState,
  { heating: true, cooling: false },
);
