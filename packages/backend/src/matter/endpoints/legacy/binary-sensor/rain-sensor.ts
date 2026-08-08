import { BooleanStateConfigurationServer } from "@matter/main/behaviors";
import { RainSensorDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { BooleanStateServer } from "../../../behaviors/boolean-state-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";

export const RainSensorType = RainSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  BooleanStateServer(),
  BooleanStateConfigurationServer,
);
