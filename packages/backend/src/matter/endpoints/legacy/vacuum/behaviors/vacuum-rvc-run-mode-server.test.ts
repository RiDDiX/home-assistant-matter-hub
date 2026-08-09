import type {
  CustomServiceArea,
  EntityMappingConfig,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { HomeAssistantAction } from "../../../../../services/home-assistant/home-assistant-actions.js";
import type { CleaningSession } from "../../../../behaviors/rvc-run-mode-server.js";
import {
  buildSupportedModes,
  dispatchRoomClean,
  handleCustomServiceAreas,
} from "./vacuum-rvc-run-mode-server.js";
import { toAreaId } from "./vacuum-service-area-server.js";

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

// Behaviour-parity guard: dispatchRoomClean is the pure helper extracted from
// the RvcRunMode start handler. Both the start path and the #355 room switches
// route through it, so these lock the exact HA action produced per integration.
describe("dispatchRoomClean", () => {
  function seam() {
    const calls: HomeAssistantAction[] = [];
    return {
      calls,
      callAction: (a: HomeAssistantAction) => {
        calls.push(a);
      },
    };
  }

  function run(
    attributes: Record<string, unknown>,
    mapping: EntityMappingConfig | undefined,
    entityId: string,
    selectedAreas: number[],
  ) {
    const s = seam();
    const result = dispatchRoomClean(
      attributes as VacuumDeviceAttributes,
      mapping,
      entityId,
      selectedAreas,
      s,
    );
    return { ...result, seamCalls: s.calls };
  }

  it("custom service areas: first action returned, rest queued as pending", () => {
    const customServiceAreas: CustomServiceArea[] = [
      { name: "Zone1", service: "script.zone1", target: "script.zone1" },
      { name: "Zone2", service: "script.zone2", target: "script.zone2" },
    ];
    const { action, pending } = run(
      {},
      { entityId: "vacuum.mow", customServiceAreas },
      "vacuum.mow",
      [1, 2],
    );
    expect(action).toEqual({
      action: "script.zone1",
      target: "script.zone1",
      data: undefined,
    });
    expect(pending).toEqual([
      {
        areaId: 2,
        action: {
          action: "script.zone2",
          target: "script.zone2",
          data: undefined,
        },
      },
    ]);
  });

  it("CLEAN_AREA: resolves selected ids to HA area ids", () => {
    const mapping: EntityMappingConfig = {
      entityId: "vacuum.x",
      cleanAreaRooms: [{ areaId: 10, name: "Office", haAreaId: "office" }],
    };
    const { action, pending } = run({}, mapping, "vacuum.x", [10]);
    expect(action).toEqual({
      action: "vacuum.clean_area",
      data: { cleaning_area_id: ["office"] },
    });
    expect(pending).toEqual([]);
  });

  it("roomEntities: button.press per segment, first fired, rest pending", () => {
    const roomEntities = ["button.seg_16", "button.seg_17"];
    const mapping: EntityMappingConfig = { entityId: "vacuum.x", roomEntities };
    const selected = roomEntities.map(toAreaId);
    const { action, pending } = run({}, mapping, "vacuum.roborock", selected);
    expect(action).toEqual({
      action: "button.press",
      target: "button.seg_16",
    });
    expect(pending).toEqual([
      {
        areaId: selected[1],
        action: { action: "button.press", target: "button.seg_17" },
      },
    ]);
  });

  it("valetudo: mqtt.publish segment action", () => {
    const { action, pending } = run(
      {},
      undefined,
      "vacuum.valetudo_robot",
      [3],
    );
    expect(action.action).toBe("mqtt.publish");
    expect(action.target).toBe(false);
    const data = action.data as { topic: string; payload: string };
    expect(data.topic).toBe(
      "valetudo/robot/MapSegmentationCapability/clean/set",
    );
    expect(JSON.parse(data.payload).segment_ids).toEqual(["3"]);
    expect(pending).toEqual([]);
  });

  it("dreame: clean_segment plus multi-floor pre-select through the seam", () => {
    const attributes = {
      rooms: { Main: [{ id: 1, name: "Kitchen" }] },
    };
    const { action, seamCalls } = run(
      attributes,
      undefined,
      "vacuum.dreame_l10",
      [toAreaId(1)],
    );
    expect(action).toEqual({
      action: "dreame_vacuum.vacuum_clean_segment",
      data: { segments: 1 },
    });
    expect(seamCalls).toEqual([
      {
        action: "select.select_option",
        target: "select.dreame_l10_selected_map",
        data: { option: "Main" },
      },
    ]);
  });

  it("roborock/xiaomi: send_command app_segment_clean", () => {
    const attributes = { rooms: { "16": "Kitchen", "17": "Bedroom" } };
    const { action, pending } = run(attributes, undefined, "vacuum.s6", [16]);
    expect(action).toEqual({
      action: "vacuum.send_command",
      data: { command: "app_segment_clean", params: [16] },
    });
    expect(pending).toEqual([]);
  });

  it("ecovacs: send_command spot_area with comma-joined room ids", () => {
    const attributes = { rooms: { kitchen: 4, bedroom: 8 } };
    const { action } = run(attributes, undefined, "vacuum.deebot", [4, 8]);
    expect(action).toEqual({
      action: "vacuum.send_command",
      data: {
        command: "spot_area",
        params: { mapID: 0, cleanings: 1, rooms: "4,8" },
      },
    });
  });

  it("unknown integration with rooms falls back to vacuum.start", () => {
    const attributes = { rooms: { "1": "Kitchen", notnum: "Studio" } };
    const { action, pending } = run(
      attributes,
      undefined,
      "vacuum.mystery",
      [1],
    );
    expect(action).toEqual({ action: "vacuum.start" });
    expect(pending).toEqual([]);
  });

  it("no matching area falls back to vacuum.start", () => {
    const { action } = run(
      { rooms: { "16": "Kitchen" } },
      undefined,
      "vacuum.s6",
      [999],
    );
    expect(action).toEqual({ action: "vacuum.start" });
  });
});
