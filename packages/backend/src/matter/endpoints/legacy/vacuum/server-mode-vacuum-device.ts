import type { VacuumDeviceAttributes } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { RoboticVacuumCleanerDevice } from "@matter/main/devices";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { VacuumIdentifyServer } from "./behaviors/vacuum-identify-server.js";
import { VacuumOnOffServer } from "./behaviors/vacuum-on-off-server.js";
import { VacuumPowerSourceServer } from "./behaviors/vacuum-power-source-server.js";
import {
  createDefaultRvcCleanModeServer,
  createVacuumRvcCleanModeServer,
  resolveFanSpeedList,
  resolveMopIntensityList,
} from "./behaviors/vacuum-rvc-clean-mode-server.js";
import { VacuumRvcOperationalStateServer } from "./behaviors/vacuum-rvc-operational-state-server.js";
import {
  createCleanAreaRvcRunModeServer,
  createVacuumRvcRunModeServer,
} from "./behaviors/vacuum-rvc-run-mode-server.js";
import {
  createCleanAreaServiceAreaServer,
  createCustomServiceAreaServer,
  createDefaultServiceAreaServer,
  createVacuumServiceAreaServer,
} from "./behaviors/vacuum-service-area-server.js";
import { parseVacuumRooms } from "./utils/parse-vacuum-rooms.js";

/**
 * Server Mode Vacuum Endpoint Type.
 *
 * This is different from the normal VacuumDevice:
 * - NO BridgedDeviceBasicInformationServer (BasicInformationServer)
 * - NO OnOff cluster (not part of RoboticVacuumCleaner device type spec)
 * - The device appears as a standalone Matter device, not bridged
 * - Required for Apple Home Siri voice commands and Alexa discovery
 *
 * Only clusters from the Matter RoboticVacuumCleaner device type (0x74) are included:
 * Required: Identify, RvcRunMode, RvcOperationalState
 * Optional: RvcCleanMode, ServiceArea
 * Additional: PowerSource (for battery info)
 *
 * The BasicInformation comes from the ServerNode itself, not the endpoint.
 */
const ServerModeVacuumEndpointType = RoboticVacuumCleanerDevice.with(
  VacuumIdentifyServer,
  HomeAssistantEntityBehavior,
  VacuumRvcOperationalStateServer,
);

/**
 * Creates a Server Mode Vacuum Device endpoint.
 *
 * Unlike the bridged VacuumDevice, this version does NOT include
 * BridgedDeviceBasicInformationServer, making it appear as a
 * standalone (non-bridged) Matter device.
 */
export function ServerModeVacuumDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
  includeOnOff = false,
  cleaningModeOptions?: string[],
): EndpointType | undefined {
  if (homeAssistantEntity.entity.state === undefined) {
    return undefined;
  }

  const attributes = homeAssistantEntity.entity.state
    .attributes as VacuumDeviceAttributes;

  // Add RvcRunModeServer with initial supportedModes (including room modes if available)
  const cleanAreaRooms = homeAssistantEntity.mapping?.cleanAreaRooms;
  const customAreas = homeAssistantEntity.mapping?.customServiceAreas;
  let device = ServerModeVacuumEndpointType.with(
    cleanAreaRooms && cleanAreaRooms.length > 0
      ? createCleanAreaRvcRunModeServer(cleanAreaRooms)
      : createVacuumRvcRunModeServer(
          attributes,
          false,
          customAreas && customAreas.length > 0 ? customAreas : undefined,
          homeAssistantEntity.mapping?.disableCustomAreaRoomModes,
        ),
  ).set({ homeAssistantEntity });

  // OnOff is NOT part of the RoboticVacuumCleaner device type spec.
  // Adding it makes the device non-conformant and causes Amazon Alexa to
  // reject it entirely (#185, #183). Only enable via feature flag if a
  // specific controller requires it.
  if (includeOnOff) {
    device = device.with(VacuumOnOffServer);
  }

  // PowerSource, adds device type 0x0011 to the descriptor alongside 0x0074.
  device = device.with(VacuumPowerSourceServer);

  // ServiceArea, included when rooms/custom areas are configured.
  const roomEntities = homeAssistantEntity.mapping?.roomEntities;
  const rooms = parseVacuumRooms(attributes);
  if (cleanAreaRooms && cleanAreaRooms.length > 0) {
    device = device.with(createCleanAreaServiceAreaServer(cleanAreaRooms));
  } else if (customAreas && customAreas.length > 0) {
    device = device.with(createCustomServiceAreaServer(customAreas));
  } else if (rooms.length > 0 || (roomEntities && roomEntities.length > 0)) {
    device = device.with(
      createVacuumServiceAreaServer(attributes, roomEntities),
    );
  } else {
    device = device.with(createDefaultServiceAreaServer());
  }

  // RvcCleanMode, always included.
  // Alexa probes for cluster 0x55 during discovery and may refuse the device without it.
  const fanSpeedList = resolveFanSpeedList(
    attributes,
    homeAssistantEntity.mapping?.suctionLevelEntity,
  );
  const mopIntensityList = resolveMopIntensityList(
    homeAssistantEntity.mapping?.mopIntensityEntity,
  );
  if (cleaningModeOptions || fanSpeedList || mopIntensityList) {
    device = device.with(
      createVacuumRvcCleanModeServer(
        attributes,
        fanSpeedList,
        mopIntensityList,
        cleaningModeOptions,
        homeAssistantEntity.mapping?.customFanSpeedTags,
      ),
    );
  } else {
    device = device.with(createDefaultRvcCleanModeServer());
  }

  return device;
}
