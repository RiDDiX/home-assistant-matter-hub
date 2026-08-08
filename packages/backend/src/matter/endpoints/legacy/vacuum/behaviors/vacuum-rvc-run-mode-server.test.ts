import type { CustomServiceArea } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { CleaningSession } from "../../../../behaviors/rvc-run-mode-server.js";
import {
  buildSupportedModes,
  handleCustomServiceAreas,
} from "./vacuum-rvc-run-mode-server.js";

function session(): CleaningSession {
  return {
    activeAreas: [],
    completedAreas: new Set(),
    lastCurrentArea: null,
    loggedShortCircuits: new Set(),
    observedCleaning: false,
    pendingDispatches: [],
    cleanedAreaBaseline: null,
  };
}

const areas: CustomServiceArea[] = [
  {
    name: "Kitchen",
    service: "xiaomi_home.vacuum_clean_room_ids",
    target: "vacuum.xiaomi_robot",
    batchDispatch: true,
    data: { room_ids: [1] },
  },
  {
    name: "Living Room",
    service: "xiaomi_home.vacuum_clean_room_ids",
    target: "vacuum.xiaomi_robot",
    batchDispatch: true,
    data: { room_ids: [2] },
  },
  {
    name: "Bedroom",
    service: "xiaomi_home.vacuum_clean_room_ids",
    target: "vacuum.xiaomi_robot",
    batchDispatch: true,
    data: { room_ids: [3] },
  },
];

describe("handleCustomServiceAreas", () => {
  it("keeps sequential dispatch as the default", () => {
    const s = session();
    const sequentialAreas: CustomServiceArea[] = areas.map(
      ({ batchDispatch: _batchDispatch, ...area }) => area,
    );

    const action = handleCustomServiceAreas([1, 2], sequentialAreas, s);

    expect(action).toEqual({
      action: "xiaomi_home.vacuum_clean_room_ids",
      target: "vacuum.xiaomi_robot",
      data: { room_ids: [1] },
    });
    expect(s.pendingDispatches).toEqual([
      {
        areaId: 2,
        action: {
          action: "xiaomi_home.vacuum_clean_room_ids",
          target: "vacuum.xiaomi_robot",
          data: { room_ids: [2] },
        },
      },
    ]);
  });

  it("combines batch area data into one call", () => {
    const s = session();

    const action = handleCustomServiceAreas([1, 2], areas, s);

    expect(action).toEqual({
      action: "xiaomi_home.vacuum_clean_room_ids",
      target: "vacuum.xiaomi_robot",
      data: {
        room_ids: [1, 2],
        selected_area_ids: [1, 2],
        selected_area_ids_csv: "1,2",
        selected_area_names: ["Kitchen", "Living Room"],
        selected_area_names_csv: "Kitchen,Living Room",
        selected_area_data: [{ room_ids: [1] }, { room_ids: [2] }],
      },
    });
    expect(s.pendingDispatches).toEqual([]);
  });

  it("concatenates nested room lists into one batch call (#367)", () => {
    const s = session();
    const nestedAreas: CustomServiceArea[] = [
      {
        name: "Kitchen",
        service: "vacuum.send_command",
        target: "vacuum.robot",
        batchDispatch: true,
        data: { params: { segments: [16] } },
      },
      {
        name: "Living Room",
        service: "vacuum.send_command",
        target: "vacuum.robot",
        batchDispatch: true,
        data: { params: { segments: [17] } },
      },
      {
        name: "Bedroom",
        service: "vacuum.send_command",
        target: "vacuum.robot",
        batchDispatch: true,
        data: { params: { segments: [18] } },
      },
    ];

    const action = handleCustomServiceAreas([1, 2, 3], nestedAreas, s);

    expect(action.data).toMatchObject({
      params: { segments: [16, 17, 18] },
      selected_area_ids: [1, 2, 3],
    });
    expect(s.pendingDispatches).toEqual([]);
  });

  it("flattens mixed array/scalar room data without dropping rooms (#367)", () => {
    const s = session();
    const mixedAreas: CustomServiceArea[] = [
      {
        name: "Kitchen",
        service: "vacuum.send_command",
        target: "vacuum.robot",
        batchDispatch: true,
        data: { rooms: [16] },
      },
      {
        name: "Living Room",
        service: "vacuum.send_command",
        target: "vacuum.robot",
        batchDispatch: true,
        data: { rooms: 17 },
      },
    ];

    const action = handleCustomServiceAreas([1, 2], mixedAreas, s);

    expect(action.data).toMatchObject({ rooms: [16, 17] });
    expect(s.pendingDispatches).toEqual([]);
  });

  it("combines primitive batch data as comma-separated values", () => {
    const s = session();
    const notifyAreas: CustomServiceArea[] = [
      {
        name: "Kitchen",
        service: "notify.send_message",
        target: "notify.xiaomi_vacuum",
        batchDispatch: true,
        data: { message: "6" },
      },
      {
        name: "Bedroom",
        service: "notify.send_message",
        target: "notify.xiaomi_vacuum",
        batchDispatch: true,
        data: { message: "3" },
      },
    ];

    const action = handleCustomServiceAreas([1, 2], notifyAreas, s);

    expect(action.data).toMatchObject({
      message: "6,3",
      selected_area_ids_csv: "1,2",
      selected_area_names_csv: "Kitchen,Bedroom",
    });
  });
});

describe("buildSupportedModes disableCustomAreaRoomModes", () => {
  // biome-ignore lint/suspicious/noExplicitAny: custom-area branch never reads attributes
  const attributes = {} as any;

  it("registers one mode per custom area by default", () => {
    const modes = buildSupportedModes(attributes, false, areas, false);
    const labels = modes.map((m) => m.label);
    // Idle + Cleaning + one mode per area (sorted alphabetically)
    expect(labels).toEqual([
      "Idle",
      "Cleaning",
      "Bedroom",
      "Kitchen",
      "Living Room",
    ]);
  });

  it("drops the room modes when disableCustomAreaRoomModes is set", () => {
    const modes = buildSupportedModes(attributes, false, areas, true);
    expect(modes.map((m) => m.label)).toEqual(["Idle", "Cleaning"]);
    for (const area of areas) {
      expect(modes.some((m) => m.label === area.name)).toBe(false);
    }
  });
});
