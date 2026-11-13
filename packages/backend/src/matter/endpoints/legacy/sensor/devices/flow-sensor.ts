import type { SensorDeviceAttributes } from "@home-assistant-matter-hub/common";
import { FlowSensorDevice } from "@matter/main/devices";
import { numericState } from "../../../../../utils/numeric-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import {
  type FlowMeasurementConfig,
  FlowMeasurementServer,
} from "../../../../behaviors/flow-measurement-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

const flowSensorConfig: FlowMeasurementConfig = {
  getValue(entity) {
    const attributes = entity.attributes as SensorDeviceAttributes;
    const flow = numericState(entity.state);
    if (flow == null) {
      return undefined;
    }
    // Convert to m³/h based on unit
    const unit = attributes.unit_of_measurement?.toLowerCase();
    if (unit === "l/min") {
      return flow * 0.06; // L/min to m³/h
    }
    if (unit === "l/h") {
      return flow / 1000; // L/h to m³/h
    }
    if (unit === "gal/min" || unit === "gpm") {
      return flow * 0.227; // US gal/min to m³/h
    }
    if (unit === "m³/h" || unit === "m3/h") {
      return flow;
    }
    // Assume m³/h by default
    return flow;
  },
};

export const FlowSensorType = FlowSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  FlowMeasurementServer(flowSensorConfig),
);
