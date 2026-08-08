import { ServiceArea } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import {
  getSession,
  RvcRunModeServer,
  type RvcRunModeServerConfig,
  RvcSupportedRunMode,
} from "./rvc-run-mode-server.js";

// finalizeProgressOnStop is private; reach it through the prototype for a
// focused test of the stop-before-finishing behavior (#367).
// biome-ignore lint/suspicious/noExplicitAny: private method access in a test
const proto = RvcRunModeServer({} as RvcRunModeServerConfig).prototype as any;

function makeServiceArea(currentArea: number | null) {
  return { state: { currentArea, progress: [] as ServiceArea.Progress[] } };
}

function callFinalize(
  endpoint: object,
  serviceArea: ReturnType<typeof makeServiceArea>,
) {
  proto.finalizeProgressOnStop.call({
    endpoint,
    agent: { get: () => serviceArea },
  });
}

describe("finalizeProgressOnStop (#367)", () => {
  it("marks reached areas Completed, the rest Skipped, and clears currentArea", () => {
    const endpoint = {};
    const session = getSession(endpoint);
    session.activeAreas = [1, 2, 3];
    session.completedAreas = new Set([1]);
    const serviceArea = makeServiceArea(2); // operating in room 2 when stopped

    callFinalize(endpoint, serviceArea);

    expect(serviceArea.state.currentArea).toBeNull();
    expect(serviceArea.state.progress).toEqual([
      { areaId: 1, status: ServiceArea.OperationalStatus.Completed },
      { areaId: 2, status: ServiceArea.OperationalStatus.Completed },
      { areaId: 3, status: ServiceArea.OperationalStatus.Skipped },
    ]);
  });

  it("does not report never-reached rooms as cleaned on an early dock", () => {
    const endpoint = {};
    const session = getSession(endpoint);
    session.activeAreas = [1, 2, 3];
    session.completedAreas = new Set(); // docked before finishing any room
    const serviceArea = makeServiceArea(1);

    callFinalize(endpoint, serviceArea);

    const statuses = serviceArea.state.progress.map((p) => p.status);
    // room 1 was being cleaned -> Completed; 2 and 3 never reached -> Skipped.
    // The old path marked every area Completed, which is the #367 bug.
    expect(statuses).toEqual([
      ServiceArea.OperationalStatus.Completed,
      ServiceArea.OperationalStatus.Skipped,
      ServiceArea.OperationalStatus.Skipped,
    ]);
    expect(
      statuses.every((s) => s === ServiceArea.OperationalStatus.Completed),
    ).toBe(false);
  });

  it("is a no-op when there is no active session", () => {
    const endpoint = {};
    getSession(endpoint); // activeAreas stays []
    const serviceArea = makeServiceArea(5);

    callFinalize(endpoint, serviceArea);

    expect(serviceArea.state.currentArea).toBeNull();
    expect(serviceArea.state.progress).toEqual([]);
  });
});

describe("updateCurrentRoomFromCleanedArea ordering (#368)", () => {
  it("maps cleaned area onto the configured clean order, not click order", () => {
    const endpoint = {};
    const session = getSession(endpoint);
    // activeAreas is in the home-app click order; the cumulative area must be
    // mapped onto the configured order (ascending areaId), not this order.
    session.activeAreas = [3, 1, 2];
    session.completedAreas = new Set();
    session.pendingDispatches = [];
    session.lastCurrentArea = null;
    session.cleanedAreaBaseline = 0;
    const serviceArea = {
      state: { currentArea: 3, progress: [] as ServiceArea.Progress[] },
    };
    const mapping = {
      cleanedAreaEntity: "sensor.cleaned",
      customServiceAreas: [{ sizeSqm: 10 }, { sizeSqm: 20 }, { sizeSqm: 30 }],
    };
    const ctx = {
      endpoint,
      agent: {
        // biome-ignore lint/suspicious/noExplicitAny: stub
        get: (beh: any) =>
          beh === HomeAssistantEntityBehavior
            ? { state: { mapping } }
            : serviceArea,
        env: { get: () => ({ getNumericState: () => 15 }) },
      },
      logShortCircuitOnce: () => {},
      trySetCurrentArea: proto.trySetCurrentArea,
      updateProgress: proto.updateProgress,
    };

    proto.updateCurrentRoomFromCleanedArea.call(ctx);

    // cleaned = 15: config order [1,2,3] with sizes 10/20/30 -> room 1 done
    // (15 >= 10), room 2 operating (15 < 30) => currentArea 2. Click order
    // [3,1,2] would land on room 3 (the bug).
    expect(serviceArea.state.currentArea).toBe(2);
  });
});

describe("changeToMode(Cleaning) room order (#368)", () => {
  function startCleaning(
    selectedAreas: number[],
    mapping: Record<string, unknown>,
  ) {
    const endpoint = {};
    const session = getSession(endpoint);
    session.activeAreas = [];
    session.completedAreas = new Set();
    session.pendingDispatches = [];
    session.lastCurrentArea = null;
    const serviceArea = {
      state: {
        selectedAreas,
        currentArea: null as number | null,
        progress: [] as ServiceArea.Progress[],
      },
    };
    const calls: unknown[] = [];
    const homeAssistant = {
      state: { mapping },
      callAction: (a: unknown) => calls.push(a),
    };
    const ctx = {
      endpoint,
      state: {
        currentMode: RvcSupportedRunMode.Idle,
        supportedModes: [
          { mode: RvcSupportedRunMode.Idle },
          { mode: RvcSupportedRunMode.Cleaning },
        ],
        config: { start: () => ({ action: "vacuum.start" }) },
      },
      agent: {
        // biome-ignore lint/suspicious/noExplicitAny: stub
        get: (beh: any) =>
          beh === HomeAssistantEntityBehavior ? homeAssistant : serviceArea,
      },
      readCleanedAreaSqm: proto.readCleanedAreaSqm,
      orderSelectedAreas: proto.orderSelectedAreas,
      trySetCurrentArea: proto.trySetCurrentArea,
      updateProgress: proto.updateProgress,
    };

    proto.changeToMode.call(ctx, { newMode: RvcSupportedRunMode.Cleaning });

    return { session, serviceArea, calls };
  }

  it("writes the ordered list back so dispatch and progress agree", () => {
    // Selection stored before the flag was enabled: the Cleaning start must
    // re-order the stored attribute too, since dispatch reads selectedAreas.
    const { session, serviceArea } = startCleaning([4, 3], {
      vacuumAscendingRoomOrder: true,
    });
    expect(session.activeAreas).toEqual([3, 4]);
    expect(serviceArea.state.selectedAreas).toEqual([3, 4]);
  });

  it("keeps the tap order by default", () => {
    const { session, serviceArea } = startCleaning([4, 3], {});

    expect(session.activeAreas).toEqual([4, 3]);
    expect(serviceArea.state.currentArea).toBe(4);
  });

  it("cleans ascending when vacuumAscendingRoomOrder is set", () => {
    const { session, serviceArea } = startCleaning([4, 3], {
      vacuumAscendingRoomOrder: true,
    });

    // Roborock-class vacuums clean batched segments in ascending id order,
    // so tracking has to follow that instead of the tap order.
    expect(session.activeAreas).toEqual([3, 4]);
    expect(serviceArea.state.currentArea).toBe(3);
  });
});
