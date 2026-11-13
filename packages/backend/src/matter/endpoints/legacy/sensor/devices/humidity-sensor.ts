import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import { HumiditySensorDevice } from "@matter/main/devices";
import { numericState } from "../../../../../utils/numeric-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  type HumidityMeasurementConfig,
  HumidityMeasurementServer,
} from "../../../../behaviors/humidity-measurement-server.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

const humiditySensorConfig: HumidityMeasurementConfig = {
  getValue({ state }: HomeAssistantEntityState) {
    return numericState(state);
  },
};

export const HumiditySensorType = HumiditySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HumidityMeasurementServer(humiditySensorConfig),
);
