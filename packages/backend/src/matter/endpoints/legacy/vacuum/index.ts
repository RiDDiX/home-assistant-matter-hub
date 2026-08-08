import type { VacuumDeviceAttributes } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import { RoboticVacuumCleanerDevice } from "@matter/main/devices";

const logger = Logger.get("VacuumDevice");

import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
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

const VacuumEndpointType = RoboticVacuumCleanerDevice.with(
  BasicInformationServer,
  VacuumIdentifyServer,
  HomeAssistantEntityBehavior,
  VacuumRvcOperationalStateServer,
);

export function VacuumDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
  includeOnOff = false,
  cleaningModeOptions?: string[],
): EndpointType | undefined {
  if (homeAssistantEntity.entity.state === undefined) {
    return undefined;
  }

  const entityId = homeAssistantEntity.entity.entity_id;
  const attributes = homeAssistantEntity.entity.state
    .attributes as VacuumDeviceAttributes;
  const customAreas = homeAssistantEntity.mapping?.customServiceAreas;

  // Debug: Log mapping info
  logger.info(
    `Creating vacuum endpoint for ${entityId}, mapping: ${JSON.stringify(homeAssistantEntity.mapping ?? "none")}`,
  );

  // Add RvcRunModeServer with initial supportedModes (including room modes if available).
  // Custom service areas are passed so they get registered as room modes.
  // Room modes are a fallback; Apple Home also uses ServiceArea.selectAreas (#317).
  const cleanAreaRooms = homeAssistantEntity.mapping?.cleanAreaRooms;
  let device = VacuumEndpointType.with(
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
  // Adding it makes the device non-conformant and causes Amazon Alexa
  // to reject it entirely (#185, #183). Apple Home may also render the
  // vacuum incorrectly. Only enable via feature flag if needed.
  if (includeOnOff) {
    logger.info(`${entityId}: Adding OnOff cluster (vacuumOnOff flag enabled)`);
    device = device.with(VacuumOnOffServer);
  }

  // PowerSource, adds device type 0x0011 to the descriptor alongside 0x0074.
  device = device.with(VacuumPowerSourceServer);

  // ServiceArea, included when rooms/custom areas are configured.
  const roomEntities = homeAssistantEntity.mapping?.roomEntities;
  const rooms = parseVacuumRooms(attributes);
  logger.info(
    `${entityId}: customAreas=${customAreas?.length ?? 0}, roomEntities=${JSON.stringify(roomEntities ?? [])}, parsedRooms=${rooms.length}, cleanAreaRooms=${cleanAreaRooms?.length ?? 0}`,
  );
  if (cleanAreaRooms && cleanAreaRooms.length > 0) {
    logger.info(
      `${entityId}: Adding ServiceArea (${cleanAreaRooms.length} HA areas via CLEAN_AREA)`,
    );
    device = device.with(createCleanAreaServiceAreaServer(cleanAreaRooms));
  } else if (customAreas && customAreas.length > 0) {
    logger.info(
      `${entityId}: Adding ServiceArea (${customAreas.length} custom areas)`,
    );
    device = device.with(createCustomServiceAreaServer(customAreas));
  } else if (rooms.length > 0 || (roomEntities && roomEntities.length > 0)) {
    logger.info(`${entityId}: Adding ServiceArea (${rooms.length} rooms)`);
    device = device.with(
      createVacuumServiceAreaServer(attributes, roomEntities),
    );
  } else {
    logger.info(`${entityId}: Adding ServiceArea (default single-area)`);
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
    logger.info(
      `${entityId}: Adding RvcCleanMode (multi-mode, cleaningModeOptions=${JSON.stringify(cleaningModeOptions ?? [])}, fanSpeedList=${JSON.stringify(fanSpeedList ?? [])}, mopIntensityList=${JSON.stringify(mopIntensityList ?? [])})`,
    );
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
    logger.info(`${entityId}: Adding RvcCleanMode (default single-mode)`);
    device = device.with(createDefaultRvcCleanModeServer());
  }

  return device;
}
