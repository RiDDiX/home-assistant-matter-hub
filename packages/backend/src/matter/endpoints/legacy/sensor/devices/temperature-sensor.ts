import type { SensorDeviceAttributes } from "@home-assistant-matter-hub/common";
import { TemperatureSensorDevice } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { Temperature } from "../../../../../utils/converters/temperature.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { PowerSourceServer } from "../../../../behaviors/power-source-server.js";
import {
  type TemperatureMeasurementConfig,
  TemperatureMeasurementServer,
} from "../../../../behaviors/temperature-measurement-server.js";

const temperatureSensorConfig: TemperatureMeasurementConfig = {
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
  PowerSourceServer(batteryConfig),
);
