import {
  type SensorDeviceAttributes,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { DeviceTypeId } from "@matter/main/types";
import { diagnosticEventBus } from "../../../../services/diagnostics/diagnostic-event-bus.js";
import type { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AirQualitySensorType } from "./devices/air-quality-sensor.js";
import { BatterySensorType } from "./devices/battery-sensor.js";
import { batteryStorageEssType } from "./devices/battery-storage-ess.js";
import { CarbonMonoxideSensorType } from "./devices/carbon-monoxide-sensor.js";
import { Co2SensorType } from "./devices/co2-sensor.js";
import { ElectricalMeterType } from "./devices/electrical-meter.js";
import { FlowSensorType } from "./devices/flow-sensor.js";
import { HumiditySensorType } from "./devices/humidity-sensor.js";
import { IlluminanceSensorType } from "./devices/illuminance-sensor.js";
import { NitrogenDioxideSensorType } from "./devices/nitrogen-dioxide-sensor.js";
import { OzoneSensorType } from "./devices/ozone-sensor.js";
import { Pm1SensorType } from "./devices/pm1-sensor.js";
import { Pm10SensorType } from "./devices/pm10-sensor.js";
import { Pm25SensorType } from "./devices/pm25-sensor.js";
import { PressureSensorType } from "./devices/pressure-sensor.js";
import { RadonSensorType } from "./devices/radon-sensor.js";
import {
  TemperatureHumidityPressureSensorType,
  TemperatureHumidityPressureSensorWithBatteryType,
  TemperatureHumiditySensorType,
  TemperatureHumiditySensorWithBatteryType,
} from "./devices/temperature-humidity-sensor.js";
import {
  TemperaturePressureSensorType,
  TemperaturePressureSensorWithBatteryType,
} from "./devices/temperature-pressure-sensor.js";
import {
  TemperatureSensorType,
  TemperatureSensorWithBatteryType,
} from "./devices/temperature-sensor.js";
import { TvocSensorType } from "./devices/tvoc-sensor.js";

// Device type entries for the descriptor's deviceTypeList.
// Flat endpoints with multiple sensor clusters need all device types listed
// so controllers like SmartThings properly display each measurement (#214).
const tempDt = { deviceType: DeviceTypeId(0x0302), revision: 2 };
const humidityDt = { deviceType: DeviceTypeId(0x0307), revision: 2 };
const pressureDt = { deviceType: DeviceTypeId(0x0305), revision: 2 };

export function SensorDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  const attributes = homeAssistantEntity.entity.state
    .attributes as SensorDeviceAttributes;
  const deviceClass = attributes.device_class;
  const mapping = homeAssistantEntity.mapping;

  if (deviceClass === SensorDeviceClass.temperature) {
    const hasHumidity = !!mapping?.humidityEntity;
    const hasPressure = !!mapping?.pressureEntity;
    const hasBattery = !!mapping?.batteryEntity;

    if (hasHumidity && hasPressure && hasBattery) {
      return TemperatureHumidityPressureSensorWithBatteryType.set({
        homeAssistantEntity,
        descriptor: { deviceTypeList: [tempDt, humidityDt, pressureDt] },
      });
    }
    if (hasHumidity && hasPressure) {
      return TemperatureHumidityPressureSensorType.set({
        homeAssistantEntity,
        descriptor: { deviceTypeList: [tempDt, humidityDt, pressureDt] },
      });
    }
    if (hasHumidity && hasBattery) {
      return TemperatureHumiditySensorWithBatteryType.set({
        homeAssistantEntity,
        descriptor: { deviceTypeList: [tempDt, humidityDt] },
      });
    }
    if (hasHumidity) {
      return TemperatureHumiditySensorType.set({
        homeAssistantEntity,
        descriptor: { deviceTypeList: [tempDt, humidityDt] },
      });
    }
    if (hasPressure && hasBattery) {
      return TemperaturePressureSensorWithBatteryType.set({
        homeAssistantEntity,
        descriptor: { deviceTypeList: [tempDt, pressureDt] },
      });
    }
    if (hasPressure) {
      return TemperaturePressureSensorType.set({
        homeAssistantEntity,
        descriptor: { deviceTypeList: [tempDt, pressureDt] },
      });
    }
    if (hasBattery) {
      return TemperatureSensorWithBatteryType.set({ homeAssistantEntity });
    }
    return TemperatureSensorType.set({ homeAssistantEntity });
  }
  if (
    deviceClass === SensorDeviceClass.humidity ||
    deviceClass === SensorDeviceClass.moisture
  ) {
    // HA's "moisture" sensor device class (e.g. soil moisture, %) has the
    // same 0-100 % semantics as Matter's RelativeHumidityMeasurement. Map it
    // to the HumiditySensor device type so it is exposed to controllers
    // instead of being skipped (#273).
    return HumiditySensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.illuminance) {
    return IlluminanceSensorType.set({ homeAssistantEntity });
  }
  if (
    deviceClass === SensorDeviceClass.pressure ||
    deviceClass === SensorDeviceClass.atmospheric_pressure
  ) {
    return PressureSensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.volume_flow_rate) {
    return FlowSensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.pm25) {
    return Pm25SensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.pm10) {
    return Pm10SensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.carbon_dioxide) {
    return Co2SensorType.set({ homeAssistantEntity });
  }
  if (
    deviceClass === SensorDeviceClass.volatile_organic_compounds ||
    deviceClass === SensorDeviceClass.volatile_organic_compounds_parts
  ) {
    return TvocSensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.aqi) {
    return AirQualitySensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.carbon_monoxide) {
    return CarbonMonoxideSensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.nitrogen_dioxide) {
    return NitrogenDioxideSensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.ozone) {
    return OzoneSensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.pm1) {
    return Pm1SensorType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.radon) {
    return RadonSensorType.set({ homeAssistantEntity });
  }
  if (
    deviceClass === SensorDeviceClass.power ||
    deviceClass === SensorDeviceClass.energy ||
    deviceClass === SensorDeviceClass.voltage ||
    deviceClass === SensorDeviceClass.current
  ) {
    // Consumption sensors default to ElectricalMeter (0x0514), which Google and
    // SmartThings render. SolarPower (0x0017) stays behind the solar_power /
    // electrical_sensor overrides for generation.
    return ElectricalMeterType.set({ homeAssistantEntity });
  }
  if (deviceClass === SensorDeviceClass.battery) {
    // A battery with mapped power/energy sensors becomes a full BatteryStorage
    // ESS; a plain percent sensor keeps the lighter battery type.
    if (mapping?.batteryPowerEntity || mapping?.batteryEnergyEntity) {
      return batteryStorageEssType(mapping).set({ homeAssistantEntity });
    }
    return BatterySensorType.set({ homeAssistantEntity });
  }
  if (deviceClass) {
    diagnosticEventBus.emit(
      "entity_warning",
      `Sensor "${homeAssistantEntity.entity.entity_id}" has unsupported device_class "${deviceClass}", skipped`,
      {
        entityId: homeAssistantEntity.entity.entity_id,
        details: { device_class: deviceClass },
      },
    );
  }
  return undefined;
}
