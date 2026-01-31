export enum VacuumState {
  cleaning = "cleaning",
  docked = "docked",
  returning = "returning",
  error = "error",
  idle = "idle",
  paused = "paused",
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
   */
  rooms?: VacuumRoom[] | Record<string | number, string> | null | undefined;
  /** Alternative attribute name used by some integrations */
  segments?: VacuumRoom[] | Record<string | number, string> | null | undefined;
  /** Alternative attribute name used by some integrations */
  room_list?: VacuumRoom[] | Record<string | number, string> | null | undefined;
}
