import { ServiceArea } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { ServiceAreaServerBase } from "./service-area-server.js";

interface MockState {
  supportedAreas: { areaId: number }[];
  selectedAreas: number[];
  progress: { areaId: number; status: ServiceArea.OperationalStatus }[];
  currentArea: number | null;
}

function selectAreas(
  state: MockState,
  newAreas: number[],
  mapping?: { vacuumAscendingRoomOrder?: boolean },
) {
  const agent = mapping ? { get: () => ({ state: { mapping } }) } : undefined;
  return ServiceAreaServerBase.prototype.selectAreas.call(
    { state, agent } as unknown as ServiceAreaServerBase,
    { newAreas },
  );
}

describe("ServiceAreaServerBase.selectAreas", () => {
  it("stores the selection, resets progress and clears a stale currentArea", () => {
    const state: MockState = {
      supportedAreas: [{ areaId: 1 }, { areaId: 2 }, { areaId: 3 }],
      selectedAreas: [3],
      progress: [
        { areaId: 3, status: ServiceArea.OperationalStatus.Completed },
      ],
      currentArea: 3,
    };

    const res = selectAreas(state, [1, 2]);

    expect(res.status).toBe(ServiceArea.SelectAreasStatus.Success);
    expect(state.selectedAreas).toEqual([1, 2]);
    expect(state.currentArea).toBeNull();
    expect(state.progress).toEqual([
      { areaId: 1, status: ServiceArea.OperationalStatus.Pending },
      { areaId: 2, status: ServiceArea.OperationalStatus.Pending },
    ]);
  });

  it("rejects an unknown area without touching state", () => {
    const state: MockState = {
      supportedAreas: [{ areaId: 1 }],
      selectedAreas: [1],
      progress: [{ areaId: 1, status: ServiceArea.OperationalStatus.Pending }],
      currentArea: 1,
    };

    const res = selectAreas(state, [9]);

    expect(res.status).toBe(ServiceArea.SelectAreasStatus.UnsupportedArea);
    expect(state.selectedAreas).toEqual([1]);
    expect(state.currentArea).toBe(1);
  });

  it("dedupes repeated areas", () => {
    const state: MockState = {
      supportedAreas: [{ areaId: 1 }, { areaId: 2 }],
      selectedAreas: [],
      progress: [],
      currentArea: null,
    };

    selectAreas(state, [1, 1, 2, 2]);

    expect(state.selectedAreas).toEqual([1, 2]);
  });

  it("keeps the tap order by default (#368)", () => {
    const state: MockState = {
      supportedAreas: [{ areaId: 3 }, { areaId: 4 }],
      selectedAreas: [],
      progress: [],
      currentArea: null,
    };

    selectAreas(state, [4, 3]);

    expect(state.selectedAreas).toEqual([4, 3]);
    expect(state.progress.map((p) => p.areaId)).toEqual([4, 3]);
  });

  it("sorts ascending when vacuumAscendingRoomOrder is set (#368)", () => {
    const state: MockState = {
      supportedAreas: [{ areaId: 3 }, { areaId: 4 }, { areaId: 7 }],
      selectedAreas: [],
      progress: [],
      currentArea: null,
    };

    selectAreas(state, [7, 4, 3], { vacuumAscendingRoomOrder: true });

    expect(state.selectedAreas).toEqual([3, 4, 7]);
    expect(state.progress.map((p) => p.areaId)).toEqual([3, 4, 7]);
  });
});
