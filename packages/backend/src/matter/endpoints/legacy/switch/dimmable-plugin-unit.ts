import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import { DimmablePlugInUnitDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { LightLevelControlServer } from "../light/behaviors/light-level-control-server.js";
import { LightOnOffServer } from "../light/behaviors/light-on-off-server.js";

export const DimmablePlugInUnitType = DimmablePlugInUnitDevice.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  LightOnOffServer,
  LightLevelControlServer,
);
