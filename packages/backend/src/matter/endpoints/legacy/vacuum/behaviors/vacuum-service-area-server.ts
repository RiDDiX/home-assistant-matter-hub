import type {
  CleanAreaRoom,
  CustomServiceArea,
  VacuumDeviceAttributes,
  VacuumRoom,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { ServiceArea } from "@matter/main/clusters";
import {
  ServiceAreaServer,
  ServiceAreaServerWithMaps,
} from "../../../../behaviors/service-area-server.js";
import { parseVacuumRooms } from "../utils/parse-vacuum-rooms.js";

const logger = Logger.get("VacuumServiceAreaServer");

/**
 * Convert vacuum room ID to a Matter-compatible area ID.
 * Room IDs from HA can be strings or numbers, but Matter requires uint32.
 */
function toAreaId(roomId: string | number): number {
  if (typeof roomId === "number") {
    return roomId;
  }
  // For string IDs, use a simple hash
  let hash = 0;
  for (let i = 0; i < roomId.length; i++) {
    const char = roomId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Extract unique maps (floors) from rooms that have mapName set.
 * Returns an empty array when no rooms carry floor info.
 */
function extractMaps(rooms: VacuumRoom[]): ServiceArea.Map[] {
  const seen = new Map<string, number>();
  for (const room of rooms) {
    if (room.mapName && !seen.has(room.mapName)) {
      seen.set(room.mapName, seen.size + 1);
    }
  }
  return Array.from(seen.entries()).map(([name, mapId]) => ({ mapId, name }));
}

/**
 * Convert VacuumRoom array to Matter ServiceArea.Area array.
 * When maps are provided, each area's mapId is set to link it to its floor.
 */
function roomsToAreas(
  rooms: VacuumRoom[],
  maps: ServiceArea.Map[] = [],
): ServiceArea.Area[] {
  const mapLookup = new Map<string, number>();
  for (const m of maps) {
    mapLookup.set(m.name, m.mapId);
  }

  return rooms.map((room) => ({
    areaId: toAreaId(room.id),
    mapId: room.mapName ? (mapLookup.get(room.mapName) ?? null) : null,
    areaInfo: {
      locationInfo: {
        locationName: room.name,
        floorNumber: null,
        areaType: null,
      },
      landmarkInfo: null,
    },
  }));
}

/**
 * Build a lookup map from segment number to room name using room_mapping.
 * room_mapping format: [[segmentId, cloudRoomId, roomName], ...]
 */
function buildRoomNameLookup(
  attributes?: VacuumDeviceAttributes,
): Map<number, string> {
  const lookup = new Map<number, string>();
  const mapping = attributes?.room_mapping;
  if (!Array.isArray(mapping)) return lookup;

  for (const entry of mapping) {
    if (
      Array.isArray(entry) &&
      entry.length >= 3 &&
      (typeof entry[0] === "number" || typeof entry[0] === "string") &&
      typeof entry[2] === "string"
    ) {
      const segId =
        typeof entry[0] === "number"
          ? entry[0]
          : Number.parseInt(String(entry[0]), 10);
      if (!Number.isNaN(segId)) {
        lookup.set(segId, entry[2]);
      }
    }
  }
  return lookup;
}

/**
 * Convert button entity IDs to VacuumRoom array.
 * First tries to resolve names from room_mapping (Roborock segment -> name mapping),
 * then falls back to parsing the entity ID.
 * Example: "button.roborock_s6_6b8e_segment_18" + room_mapping -> { id: "...", name: "Badrum" }
 */
function buttonEntitiesToRooms(
  entityIds: string[],
  attributes?: VacuumDeviceAttributes,
): VacuumRoom[] {
  const nameLookup = buildRoomNameLookup(attributes);

  return entityIds.map((entityId) => {
    // Try to extract segment number and look up in room_mapping
    const segmentMatch = entityId.match(/segment[_-]?(\d+)$/);
    if (segmentMatch && nameLookup.size > 0) {
      const segId = Number.parseInt(segmentMatch[1], 10);
      const name = nameLookup.get(segId);
      if (name) {
        return { id: entityId, name };
      }
    }

    // Fallback: extract name from entity ID
    const parts = entityId.split(".");
    const lastPart = parts[parts.length - 1] || entityId;
    // Remove common prefixes like "roborock_clean_", "vacuum_", etc.
    const cleanName = lastPart
      .replace(/^(roborock_|vacuum_|clean_|room_)+/i, "")
      .replace(/_/g, " ")
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return {
      id: entityId, // Use full entity ID as room ID for button press
      name: cleanName || lastPart,
    };
  });
}

/**
 * Create a VacuumServiceAreaServer with initial supportedAreas.
 * The areas MUST be provided at creation time for Matter.js initialization.
 * All state is set at creation time.
 *
 * Note: selectAreas only stores selected areas. Actual cleaning starts when
 * RvcRunMode.changeToMode(Cleaning) is called - the RvcRunModeServer reads
 * the selectedAreas from ServiceArea state and triggers the appropriate
 * vacuum service (dreame_vacuum.vacuum_clean_segment or vacuum.send_command).
 *
 * @param attributes - Vacuum device attributes
 * @param roomEntities - Optional array of button entity IDs for room-based cleaning (Roborock)
 * @param includeUnnamedRooms - If true, includes rooms with generic names like "Room 7". Default: false
 */
export function createVacuumServiceAreaServer(
  attributes: VacuumDeviceAttributes,
  roomEntities?: string[],
  includeUnnamedRooms = false,
) {
  let rooms: VacuumRoom[];

  // Prefer button entities if provided (Roborock integration)
  if (roomEntities && roomEntities.length > 0) {
    rooms = buttonEntitiesToRooms(roomEntities, attributes);
    logger.info(
      `Using ${rooms.length} button entities as rooms: ${rooms.map((r) => r.name).join(", ")}`,
    );
  } else {
    // Fallback to parsing rooms from vacuum attributes (Dreame, Xiaomi Miot, etc.)
    rooms = parseVacuumRooms(attributes, includeUnnamedRooms);
    if (rooms.length > 0) {
      logger.info(
        `Using ${rooms.length} rooms from attributes: ${rooms.map((r) => r.name).join(", ")}`,
      );
    }
  }

  const maps = extractMaps(rooms);
  const supportedAreas = roomsToAreas(rooms, maps);

  if (maps.length > 0) {
    return ServiceAreaServerWithMaps({
      supportedAreas,
      supportedMaps: maps,
      selectedAreas: [],
      currentArea: null,
    });
  }

  return ServiceAreaServer({
    supportedAreas,
    selectedAreas: [],
    currentArea: null,
  });
}

/**
 * Create a default ServiceAreaServer with a single "Home" area.
 * Used when no rooms are available from vacuum attributes or entity mapping.
 */
export function createDefaultServiceAreaServer() {
  return ServiceAreaServer({
    supportedAreas: [
      {
        areaId: 1,
        mapId: null,
        areaInfo: {
          locationInfo: {
            locationName: "Home",
            floorNumber: null,
            areaType: null,
          },
          landmarkInfo: null,
        },
      },
    ],
    selectedAreas: [],
    currentArea: null,
  });
}

/**
 * Create a ServiceAreaServer from user-defined custom service areas.
 * Each area maps to a custom HA service call (e.g., script.mow_zone_1).
 * Area IDs are assigned sequentially starting from 1.
 *
 * @param customAreas - Array of custom service area definitions from entity mapping config
 */
export function createCustomServiceAreaServer(
  customAreas: CustomServiceArea[],
) {
  const supportedAreas: ServiceArea.Area[] = customAreas.map((area, index) => ({
    areaId: index + 1,
    mapId: null,
    areaInfo: {
      locationInfo: {
        locationName: area.name,
        floorNumber: null,
        areaType: null,
      },
      landmarkInfo: null,
    },
  }));

  logger.info(
    `Using ${customAreas.length} custom service areas: ${customAreas.map((a) => a.name).join(", ")}`,
  );

  return ServiceAreaServer({
    supportedAreas,
    selectedAreas: [],
    currentArea: null,
  });
}

/**
 * Create a ServiceAreaServer from HA areas resolved via CLEAN_AREA mapping.
 * Each area corresponds to an HA area that the user has mapped vacuum segments to.
 * When cleaning is triggered, the RvcRunModeServer calls vacuum.clean_area
 * with the corresponding HA area IDs.
 */
export function createCleanAreaServiceAreaServer(
  cleanAreaRooms: CleanAreaRoom[],
) {
  const supportedAreas: ServiceArea.Area[] = cleanAreaRooms.map((room) => ({
    areaId: room.areaId,
    mapId: null,
    areaInfo: {
      locationInfo: {
        locationName: room.name,
        floorNumber: null,
        areaType: null,
      },
      landmarkInfo: null,
    },
  }));

  logger.info(
    `Using ${cleanAreaRooms.length} HA areas via CLEAN_AREA: ${cleanAreaRooms.map((r) => r.name).join(", ")}`,
  );

  return ServiceAreaServer({
    supportedAreas,
    selectedAreas: [],
    currentArea: null,
  });
}

/**
 * Export toAreaId for use by RvcRunModeServer to convert area IDs back to room IDs
 */
export { toAreaId };
