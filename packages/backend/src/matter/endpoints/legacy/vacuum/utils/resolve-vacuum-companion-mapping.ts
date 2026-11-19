import type {
  EntityMappingConfig,
  HomeAssistantEntityState,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import type { BridgeRegistry } from "../../../../../services/bridges/bridge-registry.js";

/** Select entities, CLEAN_AREA rooms, then Valetudo or Roborock rooms into state. */
export async function resolveVacuumCompanionMapping(
  registry: BridgeRegistry,
  entityId: string,
  deviceId: string,
  state: HomeAssistantEntityState,
  mapping: EntityMappingConfig | undefined,
  logger: Logger,
  logRooms: (message: string) => void,
): Promise<{
  mapping: EntityMappingConfig | undefined;
  state: HomeAssistantEntityState;
}> {
  let effectiveMapping = mapping;
  const vacuumEntities = registry.findVacuumSelectEntities(deviceId);
  if (
    !effectiveMapping?.cleaningModeEntity &&
    vacuumEntities.cleaningModeEntity
  ) {
    effectiveMapping = {
      ...effectiveMapping,
      entityId: effectiveMapping?.entityId ?? entityId,
      cleaningModeEntity: vacuumEntities.cleaningModeEntity,
    };
    logger.info(
      `Auto-assigned cleaningMode ${vacuumEntities.cleaningModeEntity} to ${entityId}`,
    );
  }
  if (
    !effectiveMapping?.suctionLevelEntity &&
    vacuumEntities.suctionLevelEntity
  ) {
    effectiveMapping = {
      ...effectiveMapping,
      entityId: effectiveMapping?.entityId ?? entityId,
      suctionLevelEntity: vacuumEntities.suctionLevelEntity,
    };
    logger.info(
      `Auto-assigned suctionLevel ${vacuumEntities.suctionLevelEntity} to ${entityId}`,
    );
  }
  if (
    !effectiveMapping?.mopIntensityEntity &&
    vacuumEntities.mopIntensityEntity
  ) {
    effectiveMapping = {
      ...effectiveMapping,
      entityId: effectiveMapping?.entityId ?? entityId,
      mopIntensityEntity: vacuumEntities.mopIntensityEntity,
    };
    logger.info(
      `Auto-assigned mopIntensity ${vacuumEntities.mopIntensityEntity} to ${entityId}`,
    );
  }
  if (
    !effectiveMapping?.currentRoomEntity &&
    vacuumEntities.currentRoomEntity
  ) {
    effectiveMapping = {
      ...effectiveMapping,
      entityId: effectiveMapping?.entityId ?? entityId,
      currentRoomEntity: vacuumEntities.currentRoomEntity,
    };
    logger.info(
      `Auto-assigned currentRoom ${vacuumEntities.currentRoomEntity} to ${entityId}`,
    );
  }

  // HA 2026.3 CLEAN_AREA: when supported and area_mapping is configured, it
  // takes priority over all vendor-specific room detection.
  const supportedFeatures =
    (state.attributes as VacuumDeviceAttributes).supported_features ?? 0;
  const cleanAreaRooms = await registry.resolveCleanAreaRooms(
    entityId,
    supportedFeatures,
  );
  if (cleanAreaRooms.length > 0) {
    effectiveMapping = {
      ...effectiveMapping,
      entityId: effectiveMapping?.entityId ?? entityId,
      cleanAreaRooms,
    };
    logger.info(
      `Using ${cleanAreaRooms.length} HA areas via CLEAN_AREA for ${entityId}`,
    );
  }

  // Auto-detect rooms when no rooms in attributes and no CLEAN_AREA mapping
  const vacAttrs = state.attributes as VacuumDeviceAttributes;
  if (
    cleanAreaRooms.length === 0 &&
    !vacAttrs.rooms &&
    !vacAttrs.segments &&
    !vacAttrs.room_mapping
  ) {
    // Try Valetudo map segments sensor (sensor.*_map_segments on same device)
    const valetudoRooms = registry.findValetudoMapSegments(deviceId);
    if (valetudoRooms.length > 0) {
      const roomsObj: Record<string, string> = {};
      for (const r of valetudoRooms) {
        roomsObj[String(r.id)] = r.name;
      }
      state = {
        ...state,
        attributes: {
          ...state.attributes,
          rooms: roomsObj,
        } as typeof state.attributes,
      };
      logRooms(
        `Auto-detected ${valetudoRooms.length} Valetudo segments for ${entityId}`,
      );
    } else {
      // Try Roborock integration service call
      const roborockRooms = await registry.resolveRoborockRooms(entityId);
      if (roborockRooms.length > 0) {
        const roomsObj: Record<string, string> = {};
        for (const r of roborockRooms) {
          roomsObj[String(r.id)] = r.name;
        }
        state = {
          ...state,
          attributes: {
            ...state.attributes,
            rooms: roomsObj,
          } as typeof state.attributes,
        };
        logRooms(
          `Auto-detected ${roborockRooms.length} Roborock rooms for ${entityId}`,
        );
      }
    }
  }

  return { mapping: effectiveMapping, state };
}
