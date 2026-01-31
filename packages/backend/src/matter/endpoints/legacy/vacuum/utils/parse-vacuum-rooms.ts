import type {
  VacuumDeviceAttributes,
  VacuumRoom,
} from "@home-assistant-matter-hub/common";

/**
 * Parse vacuum rooms from various attribute formats.
 * Different integrations store rooms in different formats:
 * - Array of VacuumRoom objects: [{ id: 1, name: "Kitchen" }, ...]
 * - Record/Object: { 1: "Kitchen", 2: "Living Room", ... }
 * - May be in 'rooms', 'segments', or 'room_list' attribute
 *
 * @returns Array of normalized VacuumRoom objects, or empty array if no rooms found
 */
export function parseVacuumRooms(
  attributes: VacuumDeviceAttributes,
): VacuumRoom[] {
  const roomsData =
    attributes.rooms ?? attributes.segments ?? attributes.room_list;

  if (!roomsData) {
    return [];
  }

  // Handle array format
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

  // Handle Record/Object format: { id: name, ... }
  if (typeof roomsData === "object") {
    const rooms: VacuumRoom[] = [];
    for (const [key, value] of Object.entries(roomsData)) {
      if (typeof value === "string") {
        // Key could be numeric string or actual string
        const id = /^\d+$/.test(key) ? Number.parseInt(key, 10) : key;
        rooms.push({
          id,
          name: value,
        });
      }
    }
    return rooms;
  }

  return [];
}

/**
 * Base mode value for room-specific cleaning modes.
 * Room modes start at 100 to avoid conflicts with standard modes (Idle=0, Cleaning=1).
 */
export const ROOM_MODE_BASE = 100;

/**
 * Calculate the mode value for a specific room.
 * @param roomIndex - The index of the room in the rooms array (0-based)
 * @returns The mode value for this room
 */
export function getRoomModeValue(roomIndex: number): number {
  return ROOM_MODE_BASE + roomIndex;
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
 * Get the room index from a room mode value.
 * @param mode - The room mode value
 * @returns The room index (0-based), or -1 if not a room mode
 */
export function getRoomIndexFromMode(mode: number): number {
  if (!isRoomMode(mode)) {
    return -1;
  }
  return mode - ROOM_MODE_BASE;
}
