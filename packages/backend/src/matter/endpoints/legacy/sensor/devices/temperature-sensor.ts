import type { SensorDeviceAttributes } from "@home-assistant-matter-hub/common";
import { TemperatureSensorDevice } from "@matter/main/devices";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { Temperature } from "../../../../../utils/converters/temperature.js";
import { numericState } from "../../../../../utils/numeric-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import {
  mappedBatteryConfig,
  PowerSourceServer,
} from "../../../../behaviors/power-source-server.js";
import {
  type TemperatureMeasurementConfig,
  TemperatureMeasurementServer,
} from "../../../../behaviors/temperature-measurement-server.js";

export const temperatureSensorConfig: TemperatureMeasurementConfig = {
  getValue(entity, agent) {
    const fallbackUnit =
      agent.env.get(HomeAssistantConfig).unitSystem.temperature;
    const state = entity.state;
    const attributes = entity.attributes as SensorDeviceAttributes;
    const temperature = numericState(state);
    if (temperature == null) {
      return undefined;
    }
    return Temperature.withUnit(
      temperature,
      attributes.unit_of_measurement ?? fallbackUnit,
    );
  },
};

export const TemperatureSensorType = TemperatureSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  TemperatureMeasurementServer(temperatureSensorConfig),
);

export const TemperatureSensorWithBatteryType = TemperatureSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  TemperatureMeasurementServer(temperatureSensorConfig),
  PowerSourceServer(mappedBatteryConfig),
);
