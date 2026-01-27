import { AirQualitySensorDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { Pm10ConcentrationMeasurementServer } from "../../../../behaviors/pm10-concentration-measurement-server.js";

export const Pm10SensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  Pm10ConcentrationMeasurementServer,
);
