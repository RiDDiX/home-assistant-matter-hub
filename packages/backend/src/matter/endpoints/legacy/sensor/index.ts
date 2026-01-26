import {
  type SensorDeviceAttributes,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import type { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AirQualitySensorType } from "./devices/air-quality-sensor.js";
import { HumiditySensorType } from "./devices/humidity-sensor.js";
import { IlluminanceSensorType } from "./devices/illuminance-sensor.js";
import { TemperatureSensorType } from "./devices/temperature-sensor.js";

export function SensorDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  const attributes = homeAssistantEntity.entity.state
    .attributes as SensorDeviceAttributes;
  const deviceClass = attributes.device_class;

  if (deviceClass === SensorDeviceClass.temperature) {
    return TemperatureSensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.humidity) {
    return HumiditySensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.illuminance) {
    return IlluminanceSensorType.set({ homeAssistantEntity });
  }
  // Air quality sensors (AQI, PM2.5, PM10, CO2, VOC)
  if (
    deviceClass === SensorDeviceClass.aqi ||
    deviceClass === SensorDeviceClass.pm25 ||
    deviceClass === SensorDeviceClass.pm10 ||
    deviceClass === SensorDeviceClass.carbon_dioxide ||
    deviceClass === SensorDeviceClass.volatile_organic_compounds ||
    deviceClass === SensorDeviceClass.volatile_organic_compounds_parts
  ) {
    return AirQualitySensorType.set({ homeAssistantEntity });
  }
  return undefined;
}
