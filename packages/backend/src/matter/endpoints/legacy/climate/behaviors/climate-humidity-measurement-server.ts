import type {
  ClimateDeviceAttributes,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { numericState } from "../../../../../utils/numeric-state.js";
import {
  type HumidityMeasurementConfig,
  HumidityMeasurementServer,
} from "../../../../behaviors/humidity-measurement-server.js";

const humidityConfig: HumidityMeasurementConfig = {
  getValue(entity: HomeAssistantEntityState) {
    const attributes = entity.attributes as ClimateDeviceAttributes;
    return numericState(attributes.current_humidity);
  },
};

export const ClimateHumidityMeasurementServer =
  HumidityMeasurementServer(humidityConfig);
