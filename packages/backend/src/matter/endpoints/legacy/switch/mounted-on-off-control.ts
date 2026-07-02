import {
  DescriptorServer,
  GroupsServer,
  ScenesManagementServer,
} from "@matter/main/behaviors";
import {
  MountedOnOffControlDevice,
  OnOffPlugInUnitDevice,
} from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

// #380: expose an HA switch as Mounted On/Off Control (0x010F).
// The spec mandates the OnOff Lighting feature on this type and recommends
// listing the On/Off Plug-in Unit subset so pre-1.4 controllers (Apple,
// Google, Alexa) fall back to a plug instead of an unknown type.
export const MountedOnOffControlType = MountedOnOffControlDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  OnOffServer().with("Lighting"),
  // Explicit so the deviceTypeList default below actually applies.
  DescriptorServer,
).set({
  descriptor: {
    deviceTypeList: [
      {
        deviceType: MountedOnOffControlDevice.deviceType,
        revision: MountedOnOffControlDevice.deviceRevision,
      },
      {
        deviceType: OnOffPlugInUnitDevice.deviceType,
        revision: OnOffPlugInUnitDevice.deviceRevision,
      },
    ],
  },
});
