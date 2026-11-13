import type { SensorDeviceAttributes } from "@home-assistant-matter-hub/common";
import { PressureSensorDevice } from "@matter/main/devices";
import { convertPressureToHpa } from "../../../../../utils/converters/pressure.js";
import { numericState } from "../../../../../utils/numeric-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import {
  type PressureMeasurementConfig,
  PressureMeasurementServer,
} from "../../../../behaviors/pressure-measurement-server.js";

const pressureSensorConfig: PressureMeasurementConfig = {
  getValue(entity) {
    const state = entity.state;
    const attributes = entity.attributes as SensorDeviceAttributes;
    const pressure = numericState(state);
    if (pressure == null) {
      return undefined;
    }
    return convertPressureToHpa(pressure, attributes.unit_of_measurement);
  },
};

export const PressureSensorType = PressureSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  PressureMeasurementServer(pressureSensorConfig),
);
