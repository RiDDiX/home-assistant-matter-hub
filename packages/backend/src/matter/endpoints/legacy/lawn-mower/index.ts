import type { LawnMowerDeviceAttributes } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { RoboticVacuumCleanerDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { DefaultPowerSourceServer } from "../../../behaviors/power-source-server.js";
import { LawnMowerRvcOperationalStateServer } from "./behaviors/lawn-mower-rvc-operational-state-server.js";
import { createLawnMowerRvcRunModeServer } from "./behaviors/lawn-mower-rvc-run-mode-server.js";

// HA lawn_mower has no native Matter device type. RoboticVacuumCleaner (0x0074)
// is the closest fit and is supported by Apple Home (iOS 18.4+), Google, and
// Alexa, so a mower appears and is controlled as a robot vacuum (#301 follow-up).
const LawnMowerEndpointType = RoboticVacuumCleanerDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  LawnMowerRvcOperationalStateServer,
);

export function LawnMowerDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  if (homeAssistantEntity.entity.state === undefined) {
    return undefined;
  }

  const attributes = homeAssistantEntity.entity.state
    .attributes as LawnMowerDeviceAttributes;

  let device = LawnMowerEndpointType.with(
    createLawnMowerRvcRunModeServer(),
  ).set({ homeAssistantEntity });

  // Battery is optional for mowers, only add PowerSource when one exists
  // (mapped battery entity or a battery attribute on the mower entity).
  const hasBattery =
    homeAssistantEntity.mapping?.batteryEntity != null ||
    attributes.battery_level != null ||
    attributes.battery != null;
  if (hasBattery) {
    device = device.with(DefaultPowerSourceServer);
  }

  return device;
}
