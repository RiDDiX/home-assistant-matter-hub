import type {
  VacuumDeviceAttributes,
  VacuumRoom,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import {
  getRoomIdFromMode,
  getRoomModeValue,
  isDreameVacuum,
  isEcovacsVacuum,
  isRoomMode,
  isUnnamedRoom,
  isXiaomiMiotVacuum,
  parseVacuumRooms,
  ROOM_MODE_BASE,
} from "./parse-vacuum-rooms.js";

describe("parseVacuumRooms", () => {
  it("should parse direct array format", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: [
        { id: 1, name: "Kitchen" },
        { id: 2, name: "Living Room" },
      ],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 1, name: "Kitchen", icon: undefined },
      { id: 2, name: "Living Room", icon: undefined },
    ]);
  });

  it("should parse simple object format", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        "1": "Kitchen",
        "2": "Living Room",
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 1, name: "Kitchen" },
      { id: 2, name: "Living Room" },
    ]);
  });

  it("should parse nested/Dreame format", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        "Ground Floor": [
          { id: 1, name: "Kitchen" },
          { id: 2, name: "Living Room" },
        ],
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      {
        id: 1,
        name: "Kitchen",
        icon: undefined,
        originalId: 1,
        mapName: "Ground Floor",
      },
      {
        id: 2,
        name: "Living Room",
        icon: undefined,
        originalId: 2,
        mapName: "Ground Floor",
      },
    ]);
  });

  it("should deduplicate room IDs across floors in Dreame format", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        Upstairs: [
          { id: 1, name: "Bedroom" },
          { id: 2, name: "Bathroom" },
        ],
        Downstairs: [
          { id: 1, name: "Kitchen" },
          { id: 2, name: "Living Room" },
        ],
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toHaveLength(4);
    // All IDs must be unique
    const ids = result.map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
    // originalId preserves per-floor IDs, mapName preserves floor name
    expect(result[0]).toMatchObject({
      name: "Bedroom",
      originalId: 1,
      mapName: "Upstairs",
    });
    expect(result[1]).toMatchObject({
      name: "Bathroom",
      originalId: 2,
      mapName: "Upstairs",
    });
    expect(result[2]).toMatchObject({
      name: "Kitchen",
      originalId: 1,
      mapName: "Downstairs",
    });
    expect(result[3]).toMatchObject({
      name: "Living Room",
      originalId: 2,
      mapName: "Downstairs",
    });
    // Floor 0 IDs unchanged, Floor 1 IDs offset by 10000
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(2);
    expect(result[2].id).toBe(10001);
    expect(result[3].id).toBe(10002);
  });

  it("should filter out unnamed rooms by default", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: [
        { id: 1, name: "Kitchen" },
        { id: 2, name: "Room 7" },
        { id: 3, name: "Raum 3" },
      ],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([{ id: 1, name: "Kitchen", icon: undefined }]);
  });

  it("should include unnamed rooms when requested", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: [
        { id: 1, name: "Kitchen" },
        { id: 2, name: "Room 7" },
      ],
    };
    const result = parseVacuumRooms(attributes, true);
    expect(result).toHaveLength(2);
  });

  it("should fallback to segments attribute", () => {
    const attributes: VacuumDeviceAttributes = {
      segments: [{ id: 1, name: "Kitchen" }],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([{ id: 1, name: "Kitchen", icon: undefined }]);
  });

  it("should fallback to room_list attribute", () => {
    const attributes: VacuumDeviceAttributes = {
      room_list: [{ id: 1, name: "Kitchen" }],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([{ id: 1, name: "Kitchen", icon: undefined }]);
  });

  it("should return empty array when no rooms found", () => {
    const attributes: VacuumDeviceAttributes = {};
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([]);
  });

  it("should handle string IDs", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: [
        { id: "kitchen_1", name: "Kitchen" },
        { id: "living_2", name: "Living Room" },
      ],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toHaveLength(2);
  });

  it("should preserve icon property", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: [{ id: 1, name: "Kitchen", icon: "mdi:silverware-fork-knife" }],
    };
    const result = parseVacuumRooms(attributes);
    expect(result[0].icon).toBe("mdi:silverware-fork-knife");
  });

  it("should handle mixed object format with non-numeric keys", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        kitchen: "Kitchen",
        living: "Living Room",
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: "kitchen", name: "Kitchen" },
      { id: "living", name: "Living Room" },
    ]);
  });

  it("should parse Ecovacs format 1 (room_name: id)", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        dining_room: 0,
        corridor: 1,
        kitchen: 4,
        bathroom: 6,
        study: 3,
        laundry: 5,
        living_room: 2,
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 0, name: "Dining Room" },
      { id: 1, name: "Corridor" },
      { id: 4, name: "Kitchen" },
      { id: 6, name: "Bathroom" },
      { id: 3, name: "Study" },
      { id: 5, name: "Laundry" },
      { id: 2, name: "Living Room" },
    ]);
  });

  it("should parse Ecovacs format 2 (room_name: id or [id1, id2])", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        bedroom: [1, 3],
        corridor: 2,
        bathroom: [4, 8],
        default: 6,
        study: 7,
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 1, name: "Bedroom 1" },
      { id: 3, name: "Bedroom 2" },
      { id: 2, name: "Corridor" },
      { id: 4, name: "Bathroom 1" },
      { id: 8, name: "Bathroom 2" },
      { id: 6, name: "Default" },
      { id: 7, name: "Study" },
    ]);
  });

  it("should handle Ecovacs format with single-element array", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        bedroom: [5],
        kitchen: 2,
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 5, name: "Bedroom" },
      { id: 2, name: "Kitchen" },
    ]);
  });

  it("should handle Ecovacs format with triple or more rooms", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        bedroom: [1, 2, 3, 4],
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 1, name: "Bedroom 1" },
      { id: 2, name: "Bedroom 2" },
      { id: 3, name: "Bedroom 3" },
      { id: 4, name: "Bedroom 4" },
    ]);
  });

  it("should properly capitalize multi-word room names", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        master_bedroom: 1,
        guest_bathroom: 2,
        home_office: 3,
      },
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 1, name: "Master Bedroom" },
      { id: 2, name: "Guest Bathroom" },
      { id: 3, name: "Home Office" },
    ]);
  });
});

describe("isUnnamedRoom", () => {
  it("should detect English unnamed rooms", () => {
    expect(isUnnamedRoom("Room 1")).toBe(true);
    expect(isUnnamedRoom("Room 7")).toBe(true);
  });

  it("should detect German unnamed rooms", () => {
    expect(isUnnamedRoom("Raum 3")).toBe(true);
    expect(isUnnamedRoom("Zimmer 5")).toBe(true);
  });

  it("should detect French unnamed rooms", () => {
    expect(isUnnamedRoom("Chambre 2")).toBe(true);
  });

  it("should detect Spanish unnamed rooms", () => {
    expect(isUnnamedRoom("Habitación 4")).toBe(true);
  });

  it("should detect Italian unnamed rooms", () => {
    expect(isUnnamedRoom("Stanza 6")).toBe(true);
  });

  it("should not match named rooms", () => {
    expect(isUnnamedRoom("Kitchen")).toBe(false);
    expect(isUnnamedRoom("Living Room")).toBe(false);
    expect(isUnnamedRoom("Master Bedroom")).toBe(false);
  });

  it("should handle case insensitive matching", () => {
    expect(isUnnamedRoom("room 1")).toBe(true);
    expect(isUnnamedRoom("ROOM 1")).toBe(true);
  });

  it("should trim whitespace", () => {
    expect(isUnnamedRoom("  Room 1  ")).toBe(true);
  });
});

describe("getRoomModeValue", () => {
  it("should calculate mode value for numeric room ID", () => {
    const room: VacuumRoom = { id: 5, name: "Kitchen" };
    expect(getRoomModeValue(room)).toBe(ROOM_MODE_BASE + 5);
  });

  it("should calculate mode value for string room ID", () => {
    const room: VacuumRoom = { id: "kitchen", name: "Kitchen" };
    const result = getRoomModeValue(room);
    expect(result).toBeGreaterThanOrEqual(ROOM_MODE_BASE);
  });

  it("should return consistent values for same string ID", () => {
    const room1: VacuumRoom = { id: "kitchen", name: "Kitchen" };
    const room2: VacuumRoom = { id: "kitchen", name: "Kitchen" };
    expect(getRoomModeValue(room1)).toBe(getRoomModeValue(room2));
  });
});

describe("isRoomMode", () => {
  it("should identify room modes", () => {
    expect(isRoomMode(ROOM_MODE_BASE)).toBe(true);
    expect(isRoomMode(ROOM_MODE_BASE + 5)).toBe(true);
    expect(isRoomMode(ROOM_MODE_BASE + 100)).toBe(true);
  });

  it("should reject standard modes", () => {
    expect(isRoomMode(0)).toBe(false);
    expect(isRoomMode(1)).toBe(false);
    expect(isRoomMode(99)).toBe(false);
  });
});

describe("getRoomIdFromMode", () => {
  it("should extract room ID from mode value", () => {
    expect(getRoomIdFromMode(ROOM_MODE_BASE + 5)).toBe(5);
    expect(getRoomIdFromMode(ROOM_MODE_BASE + 42)).toBe(42);
  });

  it("should return -1 for non-room modes", () => {
    expect(getRoomIdFromMode(0)).toBe(-1);
    expect(getRoomIdFromMode(1)).toBe(-1);
    expect(getRoomIdFromMode(99)).toBe(-1);
  });
});

describe("isDreameVacuum", () => {
  it("should detect Dreame format", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        "Ground Floor": [
          { id: 1, name: "Kitchen" },
          { id: 2, name: "Living Room" },
        ],
      },
    };
    expect(isDreameVacuum(attributes)).toBe(true);
  });

  it("should not detect array format as Dreame", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: [
        { id: 1, name: "Kitchen" },
        { id: 2, name: "Living Room" },
      ],
    };
    expect(isDreameVacuum(attributes)).toBe(false);
  });

  it("should not detect simple object format as Dreame", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        "1": "Kitchen",
        "2": "Living Room",
      },
    };
    expect(isDreameVacuum(attributes)).toBe(false);
  });

  it("should not detect Ecovacs numeric id arrays as Dreame", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: { kitchen: 1, bedroom: [3, 5], living_room: 2 },
    };
    expect(isDreameVacuum(attributes)).toBe(false);
  });

  it("should return false when no rooms attribute", () => {
    const attributes: VacuumDeviceAttributes = {};
    expect(isDreameVacuum(attributes)).toBe(false);
  });

  it("should return false when rooms is null", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: null,
    };
    expect(isDreameVacuum(attributes)).toBe(false);
  });
});

describe("room_mapping (Roborock/Xiaomi Miot)", () => {
  it("should parse room_mapping format", () => {
    const attributes: VacuumDeviceAttributes = {
      room_mapping: [
        [16, "152001108957", "Tvättstuga"],
        [17, "152001108956", "Kontor"],
        [18, "152001108958", "Badrum"],
        [19, "152001066658", "Hall"],
      ],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 16, name: "Tvättstuga" },
      { id: 17, name: "Kontor" },
      { id: 18, name: "Badrum" },
      { id: 19, name: "Hall" },
    ]);
  });

  it("should handle string segment IDs in room_mapping", () => {
    const attributes: VacuumDeviceAttributes = {
      room_mapping: [
        ["16", "cloud1", "Kitchen"],
        ["17", "cloud2", "Bedroom"],
      ],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([
      { id: 16, name: "Kitchen" },
      { id: 17, name: "Bedroom" },
    ]);
  });

  it("should prefer rooms/segments/room_list over room_mapping", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: [{ id: 1, name: "FromRooms" }],
      room_mapping: [[16, "cloud1", "FromMapping"]],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([{ id: 1, name: "FromRooms", icon: undefined }]);
  });

  it("should return empty for invalid room_mapping", () => {
    const attributes: VacuumDeviceAttributes = {
      room_mapping: ["not", "valid"],
    };
    const result = parseVacuumRooms(attributes);
    expect(result).toEqual([]);
  });

  it("should detect Roborock with room_mapping as Xiaomi Miot", () => {
    const attributes: VacuumDeviceAttributes = {
      room_mapping: [[16, "cloud1", "Kitchen"]],
    };
    expect(isXiaomiMiotVacuum(attributes)).toBe(true);
  });

  it("should not detect empty room_mapping as Xiaomi Miot", () => {
    const attributes: VacuumDeviceAttributes = {
      room_mapping: [],
    };
    expect(isXiaomiMiotVacuum(attributes)).toBe(false);
  });
});

describe("isEcovacsVacuum", () => {
  it("should detect Ecovacs T20 Omni format (room_name: numeric_id)", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        flur: 0,
        wohnzimmer: 8,
        esszimmer: 9,
        buro: 4,
        schlafzimmer: 6,
        kuche: 1,
        badezimmer: 7,
      },
    };
    expect(isEcovacsVacuum(attributes)).toBe(true);
  });

  it("should detect Ecovacs rooms with numeric id arrays", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: { kitchen: 1, bedroom: [3, 5], living_room: 2 },
    };
    expect(isEcovacsVacuum(attributes)).toBe(true);
  });

  it("should not detect array format as Ecovacs", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: [
        { id: 1, name: "Kitchen" },
        { id: 2, name: "Living Room" },
      ],
    };
    expect(isEcovacsVacuum(attributes)).toBe(false);
  });

  it("should not detect Dreame nested format as Ecovacs", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        "Ground Floor": [
          { id: 1, name: "Kitchen" },
          { id: 2, name: "Living Room" },
        ],
      },
    };
    expect(isEcovacsVacuum(attributes)).toBe(false);
  });

  it("should not detect simple id:name object as Ecovacs", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        "1": "Kitchen",
        "2": "Living Room",
      },
    };
    expect(isEcovacsVacuum(attributes)).toBe(false);
  });

  it("should return false when no rooms attribute", () => {
    const attributes: VacuumDeviceAttributes = {};
    expect(isEcovacsVacuum(attributes)).toBe(false);
  });

  it("should return false when rooms is null", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: null,
    };
    expect(isEcovacsVacuum(attributes)).toBe(false);
  });

  it("should parse Ecovacs rooms correctly", () => {
    const attributes: VacuumDeviceAttributes = {
      rooms: {
        flur: 0,
        wohnzimmer: 8,
        kuche: 1,
      },
    };
    const rooms = parseVacuumRooms(attributes);
    expect(rooms).toEqual([
      { id: 0, name: "Flur" },
      { id: 8, name: "Wohnzimmer" },
      { id: 1, name: "Kuche" },
    ]);
  });
});
