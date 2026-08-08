export enum VacuumState {
  cleaning = "cleaning",
  docked = "docked",
  returning = "returning",
  error = "error",
  idle = "idle",
  paused = "paused",
  // Additional states reported by various vacuum integrations
  segment_cleaning = "segment_cleaning",
  zone_cleaning = "zone_cleaning",
  spot_cleaning = "spot_cleaning",
  mop_cleaning = "mop_cleaning",
}

export enum VacuumDeviceFeature {
  /**
   * @deprecated
   */
  TURN_ON = 1,
  /**
   * @deprecated
   */
  TURN_OFF = 2,
  PAUSE = 4,
  STOP = 8,
  RETURN_HOME = 16,
  FAN_SPEED = 32,
  BATTERY = 64,
  /**
   * @deprecated
   */
  STATUS = 128,
  SEND_COMMAND = 256,
  LOCATE = 512,
  CLEAN_SPOT = 1024,
  MAP = 2048,
  STATE = 4096,
  START = 8192,
  CLEAN_AREA = 16384,
}

export enum VacuumFanSpeed {
  off = "off",
  low = "low",
  medium = "medium",
  high = "high",
  turbo = "turbo",
  auto = "auto",
  max = "max",
}

/**
 * Room/segment info for vacuum room cleaning.
 * Different integrations provide this in different formats.
 */
export interface VacuumRoom {
  /** Room/segment ID used for cleaning commands */
  id: number | string;
  /** Human-readable room name */
  name: string;
  /** Optional icon for the room */
  icon?: string;
  /**
   * Original room ID from the vacuum integration, before any deduplication.
   * For Dreame multi-floor vacuums, each floor reuses room IDs (1, 2, 3...),
   * so `id` is made unique across floors while `originalId` preserves the
   * per-floor ID needed for actual vacuum clean commands.
   */
  originalId?: number | string;
  /**
   * Floor/map name for multi-floor vacuums (e.g. Dreame nested format).
   * When present, enables the Matter ServiceArea Maps feature so controllers
   * can group and filter rooms by floor.
   */
  mapName?: string;
}

/**
 * Simple room mapping format: { "1": "Kitchen", "2": "Living Room" }
 * Key is the room ID, value is the room name.
 */
export type SimpleRoomRecord = Record<string | number, string>;

/**
 * Ecovacs room format: { dining_room: 0, bedroom: [1, 3], ... }
 * Key is the snake_case room name, value is either:
 * - A single numeric ID for one room
 * - An array of numeric IDs for multiple rooms with the same name
 */
export type EcovacsRoomRecord = Record<string, number | number[]>;

/**
 * Dreame nested room format: { "Ground Floor": [{ id: 1, name: "Kitchen" }, ...] }
 * Key is the map name, value is an array of room objects.
 */
export type DreameRoomRecord = Record<string, VacuumRoom[]>;

/**
 * All supported formats for room/segment data across different integrations.
 */
export type VacuumRoomsData =
  | VacuumRoom[]
  | SimpleRoomRecord
  | EcovacsRoomRecord
  | DreameRoomRecord
  | null
  | undefined;

/**
 * Represents an HA area mapped to vacuum segments via the HA 2026.3
 * "Map vacuum segments to areas" feature. Used when the vacuum supports
 * VacuumEntityFeature.CLEAN_AREA.
 */
export interface CleanAreaRoom {
  /** Matter ServiceArea areaId (uint32, derived from HA area_id hash) */
  areaId: number;
  /** HA area_id string (used in vacuum.clean_area action) */
  haAreaId: string;
  /** Human-readable area name from HA area registry */
  name: string;
}

export interface VacuumDeviceAttributes {
  supported_features?: number;
  battery_level?: number | string | null | undefined;
  /** Some vacuums (e.g. Dreame) use 'battery' instead of 'battery_level' */
  battery?: number | string | null | undefined;
  fan_speed?: VacuumFanSpeed | string | null | undefined;
  fan_speed_list?: string[];
  status?: string | null | undefined;
  /**
   * Room/segment list for room-specific cleaning.
   * Format varies by integration:
   * - Dreame: Often separate entities, but some have 'rooms' attribute
   * - Roborock: May have 'rooms' or 'segments' attribute
   * - Xiaomi: May have 'room_list' attribute
   * - Ecovacs: { room_name: id } or { room_name: [id1, id2] }
   */
  rooms?: VacuumRoomsData;
  /** Alternative attribute name used by some integrations */
  segments?: VacuumRoomsData;
  /** Alternative attribute name used by some integrations */
  room_list?: VacuumRoomsData;
  /**
   * Xiaomi Miot / Roborock room mapping: [[segmentId, cloudRoomId, roomName], ...]
   * Example: [[16, "152001108957", "Kitchen"], [17, "152001108956", "Bedroom"]]
   */
  room_mapping?: unknown[];
}
