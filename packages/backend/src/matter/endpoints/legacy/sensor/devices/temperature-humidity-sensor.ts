import type { SensorDeviceAttributes } from "@home-assistant-matter-hub/common";
import { DescriptorServer } from "@matter/main/behaviors";
import { TemperatureSensorDevice } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { convertPressureToHpa } from "../../../../../utils/converters/pressure.js";
import { Temperature } from "../../../../../utils/converters/temperature.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  type HumidityMeasurementConfig,
  HumidityMeasurementServer,
} from "../../../../behaviors/humidity-measurement-server.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { PowerSourceServer } from "../../../../behaviors/power-source-server.js";
import {
  type PressureMeasurementConfig,
  PressureMeasurementServer,
} from "../../../../behaviors/pressure-measurement-server.js";
import {
  type TemperatureMeasurementConfig,
  TemperatureMeasurementServer,
} from "../../../../behaviors/temperature-measurement-server.js";

const temperatureConfig: TemperatureMeasurementConfig = {
  getValue(entity, agent) {
    const fallbackUnit =
      agent.env.get(HomeAssistantConfig).unitSystem.temperature;
    const state = entity.state;
    const attributes = entity.attributes as SensorDeviceAttributes;
    const temperature = state == null || Number.isNaN(+state) ? null : +state;
    if (temperature == null) {
      return undefined;
    }
    return Temperature.withUnit(
      temperature,
      attributes.unit_of_measurement ?? fallbackUnit,
    );
  },
};

const humidityConfig: HumidityMeasurementConfig = {
  getValue(_entity, agent) {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const humidityEntity = homeAssistant.state.mapping?.humidityEntity;

    if (humidityEntity) {
      const stateProvider = agent.env.get(EntityStateProvider);
      const humidity = stateProvider.getNumericState(humidityEntity);
      if (humidity != null) {
        return humidity;
      }
    }
    return null;
  },
};

const pressureConfig: PressureMeasurementConfig = {
  getValue(_entity, agent) {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const pressureEntity = homeAssistant.state.mapping?.pressureEntity;

    if (pressureEntity) {
      const stateProvider = agent.env.get(EntityStateProvider);
      const state = stateProvider.getState(pressureEntity);
      if (state) {
        const pressure =
          state.state == null || Number.isNaN(+state.state)
            ? null
            : +state.state;
        if (pressure != null) {
          const attributes = state.attributes as SensorDeviceAttributes;
          return convertPressureToHpa(pressure, attributes.unit_of_measurement);
        }
      }
    }
    return undefined;
  },
};

const batteryConfig = {
  getBatteryPercent: (
    _entity: { attributes: unknown },
    agent: {
      get: (
        type: typeof HomeAssistantEntityBehavior,
      ) => HomeAssistantEntityBehavior;
      env: { get: (type: typeof EntityStateProvider) => EntityStateProvider };
    },
  ): number | null => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const batteryEntity = homeAssistant.state.mapping?.batteryEntity;

    if (batteryEntity) {
      const stateProvider = agent.env.get(EntityStateProvider);
      const battery = stateProvider.getBatteryPercent(batteryEntity);
      if (battery != null) {
        return Math.max(0, Math.min(100, battery));
      }
    }
    return null;
  },
};

export const TemperatureHumiditySensorType = TemperatureSensorDevice.with(
  DescriptorServer,
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  TemperatureMeasurementServer(temperatureConfig),
  HumidityMeasurementServer(humidityConfig),
);

export const TemperatureHumiditySensorWithBatteryType =
  TemperatureSensorDevice.with(
    DescriptorServer,
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    TemperatureMeasurementServer(temperatureConfig),
    HumidityMeasurementServer(humidityConfig),
    PowerSourceServer(batteryConfig),
  );

export const TemperatureHumidityPressureSensorType =
  TemperatureSensorDevice.with(
    DescriptorServer,
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    TemperatureMeasurementServer(temperatureConfig),
    HumidityMeasurementServer(humidityConfig),
    PressureMeasurementServer(pressureConfig),
  );

export const TemperatureHumidityPressureSensorWithBatteryType =
  TemperatureSensorDevice.with(
    DescriptorServer,
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    TemperatureMeasurementServer(temperatureConfig),
    HumidityMeasurementServer(humidityConfig),
    PressureMeasurementServer(pressureConfig),
    PowerSourceServer(batteryConfig),
  );
