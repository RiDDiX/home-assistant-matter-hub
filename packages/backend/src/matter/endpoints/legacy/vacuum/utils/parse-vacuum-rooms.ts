import type {
  VacuumDeviceAttributes,
  VacuumRoom,
} from "@home-assistant-matter-hub/common";
import { startCase } from "lodash-es";

/**
 * Format a room name from snake_case to Title Case.
 * Example: "dining_room" -> "Dining Room"
 */
function formatRoomName(name: string): string {
  return startCase(name);
}

/**
 * Counter for generating unique floor-based offsets when parsing
 * Dreame multi-floor nested room data. Each floor's rooms get offset
 * by floorCounter * 10000 to avoid areaId collisions across floors.
 */
let floorCounter = 0;

/**
 * Parse a single room data source into VacuumRoom array.
 * Handles multiple formats:
 * - Direct array: [{ id: 1, name: "Kitchen" }, ...]
 * - Simple object: { 1: "Kitchen", 2: "Living Room", ... }
 * - Nested/Dreame format: { "Map Name": [{ id: 1, name: "Kitchen" }, ...] }
 * - Ecovacs format 1: { dining_room: 0, kitchen: 4, ... }
 * - Ecovacs format 2: { bedroom: [1, 3], corridor: 2, ... }
 */
function parseRoomData(roomsData: unknown): VacuumRoom[] {
  if (!roomsData) {
    return [];
  }

  // Handle direct array format
  if (Array.isArray(roomsData)) {
    return roomsData
      .filter((room): room is VacuumRoom => {
        return (
          room != null &&
          typeof room === "object" &&
          "id" in room &&
          "name" in room &&
          (typeof room.id === "number" || typeof room.id === "string") &&
          typeof room.name === "string"
        );
      })
      .map((room) => ({
        id: room.id,
        name: room.name,
        icon: room.icon,
      }));
  }

  // Handle object formats
  if (typeof roomsData === "object" && roomsData !== null) {
    const rooms: VacuumRoom[] = [];
    for (const [key, value] of Object.entries(roomsData)) {
      // Format 1: Simple object { id: name, ... }
      if (typeof value === "string") {
        const id = /^\d+$/.test(key) ? Number.parseInt(key, 10) : key;
        rooms.push({ id, name: value });
      }
      // Format 2: Ecovacs format 1 { dining_room: 0, kitchen: 4, ... }
      // Key is room name, value is numeric ID
      else if (typeof value === "number") {
        const name = formatRoomName(key);
        rooms.push({ id: value, name });
      }
      // Format 3: Nested/Dreame format { "Map Name": [rooms...] }
      // The key is the map name, value is an array of room objects
      else if (Array.isArray(value)) {
        // Check if it's an array of room objects (Dreame format)
        if (
          value.length > 0 &&
          typeof value[0] === "object" &&
          value[0] !== null &&
          "id" in value[0]
        ) {
          const nestedRooms = parseRoomData(value);
          // Make IDs unique across floors by offsetting with floor index.
          // Each floor's room IDs restart from 1, so without offset
          // rooms from different floors collide (e.g. areaId 1 on 3 floors).
          const floorIndex = floorCounter++;
          for (const room of nestedRooms) {
            room.mapName = key;
            if (typeof room.id === "number") {
              room.originalId = room.id;
              room.id = floorIndex * 10000 + room.id;
            }
          }
          rooms.push(...nestedRooms);
        }
        // Ecovacs format 2: array of numeric IDs { bedroom: [1, 3], ... }
        else if (value.length > 0 && typeof value[0] === "number") {
          const roomName = formatRoomName(key);
          // If multiple IDs, append numbers: "Bedroom 1", "Bedroom 2"
          if (value.length > 1) {
            value.forEach((id: number, index: number) => {
              rooms.push({ id, name: `${roomName} ${index + 1}` });
            });
          } else {
            // Single ID, use room name as-is
            rooms.push({ id: value[0], name: roomName });
          }
        }
      }
    }
    return rooms;
  }

  return [];
}

/**
 * Parse Xiaomi Miot / Roborock room_mapping format.
 * Format: [[segmentId, cloudRoomId, roomName], ...]
 * Example: [[16, "152001108957", "Kitchen"], [17, "152001108956", "Bedroom"]]
 */
function parseRoomMapping(mapping: unknown): VacuumRoom[] {
  if (!Array.isArray(mapping)) return [];

  return mapping
    .filter((entry): entry is unknown[] => {
      return (
        Array.isArray(entry) &&
        entry.length >= 3 &&
        (typeof entry[0] === "number" || typeof entry[0] === "string") &&
        typeof entry[2] === "string"
      );
    })
    .map((entry) => {
      const rawId = entry[0];
      const id =
        typeof rawId === "string" ? Number.parseInt(rawId, 10) || rawId : rawId;
      return {
        id: id as number | string,
        name: entry[2] as string,
      };
    });
}

/**
 * Regular expression to match generic/unnamed room names.
 * Matches patterns like "Room 1", "Room 7", "Raum 3", etc.
 * These are typically auto-generated names for unmapped/hidden rooms.
 */
const UNNAMED_ROOM_PATTERN =
  /^(Room|Raum|Zimmer|Chambre|Habitación|Stanza)\s+\d+$/i;

/**
 * Check if a room name appears to be a generic/unnamed room.
 * Generic rooms typically have names like "Room 7" which are auto-generated
 * by vacuum integrations for unmapped or hidden rooms.
 */
export function isUnnamedRoom(roomName: string): boolean {
  return UNNAMED_ROOM_PATTERN.test(roomName.trim());
}

/**
 * Parse vacuum rooms from various attribute formats.
 * Different integrations store rooms in different formats:
 * - Array of VacuumRoom objects: [{ id: 1, name: "Kitchen" }, ...]
 * - Record/Object: { 1: "Kitchen", 2: "Living Room", ... }
 * - Nested/Dreame: { "Map Name": [{ id: 1, name: "Room" }, ...] }
 * - May be in 'rooms', 'segments', or 'room_list' attribute
 *
 * Tries each attribute in order and returns the first one with valid rooms.
 *
 * @param attributes - Vacuum device attributes
 * @param includeUnnamedRooms - If false (default), filters out rooms with generic names like "Room 7"
 * @returns Array of normalized VacuumRoom objects, or empty array if no rooms found
 */
export function parseVacuumRooms(
  attributes: VacuumDeviceAttributes,
  includeUnnamedRooms = false,
): VacuumRoom[] {
  // Reset floor counter for each parse call (avoids accumulating offsets across restarts/updates)
  floorCounter = 0;

  // Try each attribute source in order; fall through to the next when
  // the current one exists but yields no valid rooms.
  const sources = [attributes.rooms, attributes.segments, attributes.room_list];

  for (const source of sources) {
    let rooms = parseRoomData(source);
    if (rooms.length > 0) {
      // Filter out unnamed/generic rooms unless explicitly included
      if (!includeUnnamedRooms) {
        rooms = rooms.filter((room) => !isUnnamedRoom(room.name));
      }
      return rooms;
    }
  }

  // Try room_mapping (Xiaomi Miot / Roborock format: [[segmentId, cloudId, name], ...])
  let mappingRooms = parseRoomMapping(attributes.room_mapping);
  if (mappingRooms.length > 0) {
    if (!includeUnnamedRooms) {
      mappingRooms = mappingRooms.filter((room) => !isUnnamedRoom(room.name));
    }
    return mappingRooms;
  }

  return [];
}

/**
 * Base mode value for room-specific cleaning modes.
 * Room modes start at 100 to avoid conflicts with standard modes (Idle=1, Cleaning=2).
 */
export const ROOM_MODE_BASE = 100;

/**
 * Convert a room ID to a numeric mode-compatible value so ServiceArea
 * and RvcRunMode address the same room under the same number.
 */
function roomIdToNumeric(roomId: string | number): number {
  if (typeof roomId === "number") {
    return roomId;
  }
  // For string IDs, use a simple hash (same logic as toAreaId in service-area-server)
  let hash = 0;
  for (let i = 0; i < roomId.length; i++) {
    const char = roomId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Calculate the mode value for a specific room.
 * Uses the room's actual ID (not array index) to ensure consistency with ServiceArea.
 * @param room - The room object
 * @returns The mode value for this room
 */
export function getRoomModeValue(room: VacuumRoom): number {
  return ROOM_MODE_BASE + roomIdToNumeric(room.id);
}

/**
 * Check if a mode value represents a room-specific cleaning mode.
 * @param mode - The mode value to check
 * @returns True if this is a room mode, false otherwise
 */
export function isRoomMode(mode: number): boolean {
  return mode >= ROOM_MODE_BASE;
}

/**
 * Get the room ID from a room mode value.
 * @param mode - The room mode value
 * @returns The numeric room ID, or -1 if not a room mode
 */
export function getRoomIdFromMode(mode: number): number {
  if (!isRoomMode(mode)) {
    return -1;
  }
  return mode - ROOM_MODE_BASE;
}

/**
 * Detect if the vacuum uses Xiaomi Miot Auto or xiaomi_miio integration format.
 * These vacuums store rooms as a flat array of { id, name } objects and are the
 * only ones supporting the `app_segment_clean` command via `vacuum.send_command`.
 *
 * This distinguishes them from Ecovacs (dict format), Dreame (nested dict), etc.
 */
export function isXiaomiMiotVacuum(
  attributes: VacuumDeviceAttributes,
): boolean {
  // Roborock / Xiaomi Miot vacuums with room_mapping attribute
  if (
    Array.isArray(attributes.room_mapping) &&
    attributes.room_mapping.length > 0
  ) {
    return true;
  }

  const sources = [attributes.rooms, attributes.segments, attributes.room_list];
  for (const source of sources) {
    if (
      Array.isArray(source) &&
      source.length > 0 &&
      typeof source[0] === "object" &&
      source[0] !== null &&
      "id" in source[0]
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detect if the vacuum uses Dreame integration format.
 * Dreame vacuums have rooms nested under a map name key: { "Map Name": [rooms...] }
 * This is different from Roborock/Xiaomi which use flat arrays or simple objects.
 */
export function isDreameVacuum(attributes: VacuumDeviceAttributes): boolean {
  const roomsData = attributes.rooms;
  if (!roomsData || typeof roomsData !== "object" || Array.isArray(roomsData)) {
    return false;
  }

  // Check if any value is an array (Dreame nested format)
  for (const value of Object.values(roomsData)) {
    if (Array.isArray(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect if the vacuum uses the Roborock integration format.
 * Rooms resolved via roborock.get_maps have format: { "16": "Kitchen", "17": "Bedroom" }
 * Keys are numeric segment IDs (as strings), values are room names.
 * Room cleaning uses vacuum.send_command with app_segment_clean.
 */
export function isRoborockVacuum(attributes: VacuumDeviceAttributes): boolean {
  const roomsData = attributes.rooms;
  if (!roomsData || typeof roomsData !== "object" || Array.isArray(roomsData)) {
    return false;
  }

  const entries = Object.entries(roomsData);
  if (entries.length === 0) return false;

  // Roborock format: numeric string keys, string values (room names)
  return entries.every(
    ([key, value]) => /^\d+$/.test(key) && typeof value === "string",
  );
}

/**
 * Detect if the vacuum uses the Ecovacs/Deebot integration format.
 * Ecovacs vacuums store rooms as a flat dict of { room_name: numeric_id }:
 *   { flur: 0, wohnzimmer: 8, esszimmer: 9, kuche: 1, ... }
 *
 * Room cleaning uses `vacuum.send_command` with `spot_area` command:
 *   { command: "spot_area", params: { mapID: 0, cleanings: 1, rooms: "8,1,6" } }
 *
 * This is distinct from Dreame (nested arrays) and Xiaomi Miot (flat array of {id,name}).
 */
export function isEcovacsVacuum(attributes: VacuumDeviceAttributes): boolean {
  const roomsData = attributes.rooms;
  if (!roomsData || typeof roomsData !== "object" || Array.isArray(roomsData)) {
    return false;
  }

  // Ecovacs format: all values are plain numbers (room IDs), keys are room names
  // This excludes Dreame (values are arrays) and simple id:name objects (keys are numeric)
  const entries = Object.entries(roomsData);
  if (entries.length === 0) return false;

  return entries.every(
    ([key, value]) => typeof value === "number" && !/^\d+$/.test(key),
  );
}
