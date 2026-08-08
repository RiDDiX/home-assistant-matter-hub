import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import { OnOffLightDevice as Device } from "@matter/main/devices";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { DefaultPowerSourceServer } from "../../../../behaviors/power-source-server.js";
import { LightOnOffServer } from "../behaviors/light-on-off-server.js";

export const OnOffLightType = Device.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  LightOnOffServer,
);

export const OnOffLightWithBatteryType = Device.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  LightOnOffServer,
  DefaultPowerSourceServer,
);
