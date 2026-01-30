import {
  type VacuumDeviceAttributes,
  VacuumDeviceFeature,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { RoboticVacuumCleanerDevice } from "@matter/main/devices";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { VacuumOnOffServer } from "./behaviors/vacuum-on-off-server.js";
import { VacuumPowerSourceServer } from "./behaviors/vacuum-power-source-server.js";
import { VacuumRvcOperationalStateServer } from "./behaviors/vacuum-rvc-operational-state-server.js";
import { VacuumRvcRunModeServer } from "./behaviors/vacuum-rvc-run-mode-server.js";

const VacuumEndpointType = RoboticVacuumCleanerDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  VacuumRvcOperationalStateServer,
  VacuumRvcRunModeServer,
);

export function VacuumDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  if (homeAssistantEntity.entity.state === undefined) {
    return undefined;
  }

  const attributes = homeAssistantEntity.entity.state
    .attributes as VacuumDeviceAttributes;
  const supportedFeatures = attributes.supported_features ?? 0;
  let device = VacuumEndpointType.set({ homeAssistantEntity });
  if (testBit(supportedFeatures, VacuumDeviceFeature.START)) {
    device = device.with(VacuumOnOffServer);
  }
  // Add PowerSource if BATTERY feature is set OR if battery_level attribute exists
  const hasBatteryLevel =
    attributes.battery_level != null &&
    typeof attributes.battery_level === "number";
  if (
    testBit(supportedFeatures, VacuumDeviceFeature.BATTERY) ||
    hasBatteryLevel
  ) {
    device = device.with(VacuumPowerSourceServer);
  }
  return device;
}
