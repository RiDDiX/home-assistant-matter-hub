import type { WeatherEntityAttributes } from "@home-assistant-matter-hub/common";
import { TemperatureSensorDevice } from "@matter/main/devices";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { convertPressureToHpa } from "../../../../utils/converters/pressure.js";
import { Temperature } from "../../../../utils/converters/temperature.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import {
  type HumidityMeasurementConfig,
  HumidityMeasurementServer,
} from "../../../behaviors/humidity-measurement-server.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import {
  type PressureMeasurementConfig,
  PressureMeasurementServer,
} from "../../../behaviors/pressure-measurement-server.js";
import {
  type TemperatureMeasurementConfig,
  TemperatureMeasurementServer,
} from "../../../behaviors/temperature-measurement-server.js";

// A weather entity's state is the textual condition (e.g. "sunny"), so every
// numeric reading comes from attributes, never from entity.state.
export const temperatureConfig: TemperatureMeasurementConfig = {
  getValue(entity, agent) {
    const fallbackUnit =
      agent.env.get(HomeAssistantConfig).unitSystem.temperature;
    const attributes = entity.attributes as WeatherEntityAttributes;
    const temperature = attributes.temperature;
    if (temperature == null || Number.isNaN(temperature)) {
      return undefined;
    }
    return Temperature.withUnit(
      temperature,
      attributes.temperature_unit ?? fallbackUnit,
    );
  },
};

export const humidityConfig: HumidityMeasurementConfig = {
  getValue(entity) {
    const attributes = entity.attributes as WeatherEntityAttributes;
    const humidity = attributes.humidity;
    if (humidity == null || Number.isNaN(humidity)) {
      return null;
    }
    return humidity;
  },
};

export const pressureConfig: PressureMeasurementConfig = {
  getValue(entity) {
    const attributes = entity.attributes as WeatherEntityAttributes;
    const pressure = attributes.pressure;
    if (pressure == null || Number.isNaN(pressure)) {
      return undefined;
    }
    // Convert to hPa before the server's 300-1100 clamp, otherwise an inHg
    // entity (~29 to 31) falls below 300 and is silently dropped.
    return convertPressureToHpa(pressure, attributes.pressure_unit);
  },
};

export const WeatherSensorType = TemperatureSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  TemperatureMeasurementServer(temperatureConfig),
  HumidityMeasurementServer(humidityConfig),
  PressureMeasurementServer(pressureConfig),
);

export function WeatherDevice(
  homeAssistant: HomeAssistantEntityBehavior.State,
) {
  return WeatherSensorType.set({ homeAssistantEntity: homeAssistant });
}
