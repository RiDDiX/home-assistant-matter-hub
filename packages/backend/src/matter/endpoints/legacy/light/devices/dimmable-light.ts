import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import { DimmableLightDevice as Device } from "@matter/main/devices";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { DefaultPowerSourceServer } from "../../../../behaviors/power-source-server.js";
import { LightLevelControlServer } from "../behaviors/light-level-control-server.js";
import { LightOnOffServer } from "../behaviors/light-on-off-server.js";

export const DimmableLightType = Device.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  LightOnOffServer,
  LightLevelControlServer,
);

export const DimmableLightWithBatteryType = Device.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  LightOnOffServer,
  LightLevelControlServer,
  DefaultPowerSourceServer,
);
