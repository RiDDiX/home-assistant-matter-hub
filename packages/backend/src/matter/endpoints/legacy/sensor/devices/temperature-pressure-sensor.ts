import type { SensorDeviceAttributes } from "@home-assistant-matter-hub/common";
import { DescriptorServer } from "@matter/main/behaviors";
import { TemperatureSensorDevice } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { convertPressureToHpa } from "../../../../../utils/converters/pressure.js";
import { numericState } from "../../../../../utils/numeric-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import {
  mappedBatteryConfig,
  PowerSourceServer,
} from "../../../../behaviors/power-source-server.js";
import {
  type PressureMeasurementConfig,
  PressureMeasurementServer,
} from "../../../../behaviors/pressure-measurement-server.js";
import { TemperatureMeasurementServer } from "../../../../behaviors/temperature-measurement-server.js";
import { temperatureSensorConfig } from "./temperature-sensor.js";

const pressureConfig: PressureMeasurementConfig = {
  getValue(_entity, agent) {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const pressureEntity = homeAssistant.state.mapping?.pressureEntity;

    if (pressureEntity) {
      const stateProvider = agent.env.get(EntityStateProvider);
      const state = stateProvider.getState(pressureEntity);
      if (state) {
        const pressure = numericState(state.state);
        if (pressure != null) {
          const attributes = state.attributes as SensorDeviceAttributes;
          return convertPressureToHpa(pressure, attributes.unit_of_measurement);
        }
      }
    }
    return undefined;
  },
};

export const TemperaturePressureSensorType = TemperatureSensorDevice.with(
  DescriptorServer,
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  TemperatureMeasurementServer(temperatureSensorConfig),
  PressureMeasurementServer(pressureConfig),
);

export const TemperaturePressureSensorWithBatteryType =
  TemperatureSensorDevice.with(
    DescriptorServer,
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    TemperatureMeasurementServer(temperatureSensorConfig),
    PressureMeasurementServer(pressureConfig),
    PowerSourceServer(mappedBatteryConfig),
  );
