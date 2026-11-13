import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import {
  Crypto,
  Environment,
  MockCrypto,
  MockStorageService,
  Network,
  NetworkSimulator,
  StorageService,
} from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import {
  RvcOperationalStateServer,
  RvcRunModeServer,
  ServiceAreaBehavior,
} from "@matter/main/behaviors";
import { ModeBase, RvcOperationalState } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { getSession } from "../../../behaviors/rvc-run-mode-server.js";
import { getMappedEntityIds } from "../../entity-endpoint.js";
import { VacuumReadiness } from "./behaviors/vacuum-readiness.js";
import { ServerModeVacuumDevice } from "./server-mode-vacuum-device.js";

const { OperationalState, ErrorState } = RvcOperationalState;
let sequence = 0;
const servers: ServerNode[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function state(
  entity_id: string,
  value: string,
  ageMs = 10_000,
): HomeAssistantEntityState {
  return {
    entity_id,
    state: value,
    attributes: {},
    context: { id: "test" },
    last_changed: new Date(Date.now() - ageMs).toISOString(),
    last_updated: new Date().toISOString(),
  };
}

async function fixture(raw = "saving_map", mapped = true, ageMs = 10_000) {
  let readiness: HomeAssistantEntityState | undefined = state(
    "sensor.ready",
    raw,
    ageMs,
  );
  let vacuumState = "docked";
  let revision = 0;
  const entity = (): HomeAssistantEntityInformation => ({
    entity_id: "vacuum.robot",
    state: {
      ...state("vacuum.robot", vacuumState),
      // Each simulated HA event must differ even when issued in one clock tick.
      last_updated: new Date(Date.now() + revision++).toISOString(),
      attributes: {
        ...{
          supported_features: 15,
          battery_level: 100,
          fan_speed: "automatic",
          fan_speed_list: ["eco", "automatic", "performance"],
        },
      },
    },
  });
  const mapping: EntityMappingConfig = {
    entityId: "vacuum.robot",
    ...(mapped ? { readinessEntity: "sensor.ready" } : {}),
    customServiceAreas: [
      {
        name: "Kitchen",
        service: "script.clean_rooms",
        batchDispatch: true,
        data: { params: { regions: [{ region_id: "1", type: "rid" }] } },
      },
      {
        name: "Dining Room",
        service: "script.clean_rooms",
        batchDispatch: true,
        data: { params: { regions: [{ region_id: "18", type: "rid" }] } },
      },
    ],
  };
  const calls: HomeAssistantAction[] = [];
  const env = new Environment(
    `readiness-start-${sequence++}`,
    Environment.default,
  );
  env.set(StorageService, new MockStorageService(env));
  env.set(Crypto, MockCrypto());
  env.set(Network, new NetworkSimulator().addHost(1));
  env.set(EntityStateProvider, {
    getState: () => readiness,
    getNumericState: () => null,
    getBatteryPercent: () => 100,
  } as unknown as EntityStateProvider);
  env.set(HomeAssistantActions, {
    call: (action: HomeAssistantAction) => calls.push(action),
    fireEvent() {},
  } as unknown as HomeAssistantActions);
  const server = await ServerNode.create({
    environment: env,
    id: `readiness-start-${sequence}`,
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  servers.push(server);
  const type = ServerModeVacuumDevice({ entity: entity(), mapping });
  if (!type) throw new Error("missing vacuum type");
  const endpoint = new Endpoint(type, { id: "vacuum_robot" });
  await server.add(endpoint);
  const start = (mode = 1) =>
    endpoint.act((agent) =>
      agent.get(RvcRunModeServer).changeToMode({ newMode: mode }),
    );
  const op = () => endpoint.stateOf(RvcOperationalStateServer);
  const snapshot = () => {
    const s = getSession(endpoint);
    return JSON.parse(
      JSON.stringify({
        currentMode: endpoint.stateOf(RvcRunModeServer).currentMode,
        operationalState: op().operationalState,
        serviceArea: endpoint.stateOf(ServiceAreaBehavior),
        activeAreas: s.activeAreas,
        parkedAreas: s.parkedAreas,
        completedAreas: [...s.completedAreas],
        pending: s.pendingDispatches,
        haCleaning: s.haCleaning,
        observedCleaning: s.observedCleaning,
      }),
    );
  };
  return {
    endpoint,
    calls,
    start,
    op,
    snapshot,
    select: (ids: number[]) =>
      endpoint.act((agent) =>
        agent.get(ServiceAreaBehavior).selectAreas({ newAreas: ids }),
      ),
    setRawWithoutEvent(value?: string, age = 10_000) {
      readiness =
        value === undefined ? undefined : state("sensor.ready", value, age);
    },
    async update(value: string, actual = "docked", age = 10_000) {
      readiness = state("sensor.ready", value, age);
      vacuumState = actual;
      await endpoint.setStateOf(HomeAssistantEntityBehavior, {
        entity: entity(),
      });
    },
    setMapping(mapped: boolean) {
      return endpoint.setStateOf(HomeAssistantEntityBehavior, {
        mapping: {
          ...mapping,
          readinessEntity: mapped ? "sensor.ready" : undefined,
        },
      });
    },
  };
}

describe("mapped vacuum readiness at the actual Server Mode command boundary", () => {
  it.each([
    "saving_map",
    "downloading_map",
    "bin_full",
    "unknown",
    "unavailable",
  ])("rejects All Rooms during %s without dispatch or optimistic progress", async (raw) => {
    const f = await fixture(raw);
    const before = f.snapshot();
    expect((await f.start()).status).toBe(
      ModeBase.ModeChangeStatus.GenericFailure,
    );
    expect(f.calls).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  });

  it("allows All Rooms once readiness is stable", async () => {
    const f = await fixture("ready");
    expect((await f.start()).status).toBe(ModeBase.ModeChangeStatus.Success);
    expect(f.calls.map((c) => c.action)).toEqual(["vacuum.start"]);
    expect(f.op().operationalState).toBe(OperationalState.Running);
  });

  it("preserves a rejected room selection and sends one combined job on recovery", async () => {
    const f = await fixture();
    await f.select([1, 2]);
    const before = f.snapshot();
    expect((await f.start()).status).toBe(
      ModeBase.ModeChangeStatus.GenericFailure,
    );
    expect(f.snapshot()).toEqual(before);
    expect(f.calls).toEqual([]);
    await f.update("ready");
    expect((await f.start()).status).toBe(ModeBase.ModeChangeStatus.Success);
    expect(f.calls.map((c) => c.action)).toEqual(["script.clean_rooms"]);
    expect(f.calls[0]).toMatchObject({
      data: {
        selected_area_ids: [1, 2],
        selected_area_data: [
          { params: { regions: [{ region_id: "1", type: "rid" }] } },
          { params: { regions: [{ region_id: "18", type: "rid" }] } },
        ],
      },
    });
  });

  it("guards the room-mode fallback before changing any room/session state", async () => {
    const f = await fixture();
    const roomMode = f.endpoint
      .stateOf(RvcRunModeServer)
      .supportedModes.find((m) => m.mode >= 100)!.mode;
    const before = f.snapshot();
    expect((await f.start(roomMode)).status).toBe(
      ModeBase.ModeChangeStatus.GenericFailure,
    );
    expect(f.calls).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  });

  it("reads the latest sensor even before its Matter status update is processed", async () => {
    const f = await fixture("ready");
    expect(f.op().operationalState).toBe(OperationalState.Docked);
    f.setRawWithoutEvent("saving_map");
    const before = f.snapshot();
    expect((await f.start()).status).toBe(
      ModeBase.ModeChangeStatus.GenericFailure,
    );
    expect(f.calls).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  });

  it("refuses the Ready blip and downloading, then accepts stable ready", async () => {
    const f = await fixture();
    await f.update("ready", "docked", 0);
    expect((await f.start()).status).toBe(
      ModeBase.ModeChangeStatus.GenericFailure,
    );
    expect(f.op().operationalState).toBe(OperationalState.UpdatingMaps);
    await f.update("downloading_map");
    expect((await f.start()).status).toBe(
      ModeBase.ModeChangeStatus.GenericFailure,
    );
    expect(f.calls).toEqual([]);
    await f.update("ready", "docked", 6000);
    expect((await f.start()).status).toBe(ModeBase.ModeChangeStatus.Success);
    expect(f.calls.map((c) => c.action)).toEqual(["vacuum.start"]);
  });

  it.each([
    "returning",
    "error",
    "unknown",
    "unavailable",
  ])("refuses a start while %s even with a stale Ready sensor", async (actual) => {
    const f = await fixture("ready");
    await f.update("ready", actual);
    const before = f.snapshot();
    expect((await f.start()).status).toBe(
      ModeBase.ModeChangeStatus.GenericFailure,
    );
    expect(f.calls).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  });

  it("guards Resume while paused without hiding the actual paused status", async () => {
    const f = await fixture();
    await f.update("bin_full", "paused");
    const result = await f.endpoint.act((agent) =>
      agent.get(RvcOperationalStateServer).resume(),
    );
    expect(result.commandResponseState.errorStateId).toBe(
      ErrorState.UnableToStartOrResume,
    );
    expect(f.calls).toEqual([]);
    expect(f.op().operationalState).toBe(OperationalState.Paused);
    await f.update("ready", "paused");
    expect(
      (
        await f.endpoint.act((agent) =>
          agent.get(RvcOperationalStateServer).resume(),
        )
      ).commandResponseState.errorStateId,
    ).toBe(ErrorState.NoError);
    expect(f.calls.map((c) => c.action)).toEqual(["vacuum.start"]);
  });

  it("keeps Stop, Pause and Return to Dock available during map processing", async () => {
    const f = await fixture();
    const home = await f.endpoint.act((agent) =>
      agent.get(RvcOperationalStateServer).goHome(),
    );
    expect(home.commandResponseState.errorStateId).toBe(ErrorState.NoError);
    expect((await f.start(0)).status).toBe(ModeBase.ModeChangeStatus.Success);
    await f.endpoint.act((agent) =>
      agent.get(RvcOperationalStateServer).pause(),
    );
    // Docked underneath UpdatingMaps: Return to Dock stays a no-op as on alpha.
    expect(f.calls.map((c) => c.action)).toEqual([
      "vacuum.return_to_base",
      "vacuum.pause",
    ]);
  });

  it.each([
    "saving_map",
    "bin_full",
  ])("sends Return to Dock to an idle robot off the dock during %s", async (raw) => {
    const f = await fixture();
    await f.update(raw, "idle");
    await f.endpoint.act((agent) =>
      agent.get(RvcOperationalStateServer).goHome(),
    );
    expect(f.calls.map((c) => c.action)).toEqual(["vacuum.return_to_base"]);
  });

  it("does not send Return to Dock to a docked robot blocked by readiness", async () => {
    const f = await fixture("bin_full");
    expect(f.op().operationalState).toBe(OperationalState.Error);
    await f.endpoint.act((agent) =>
      agent.get(RvcOperationalStateServer).goHome(),
    );
    expect(f.calls).toEqual([]);
  });

  it("allows All Rooms when Roomba+ Prime reports none", async () => {
    const f = await fixture("none");
    expect(f.op().operationalState).toBe(OperationalState.Docked);
    expect((await f.start()).status).toBe(ModeBase.ModeChangeStatus.Success);
    expect(f.calls.map((c) => c.action)).toEqual(["vacuum.start"]);
  });

  it("fails closed when the mapped readiness entity disappears", async () => {
    const f = await fixture("ready");
    f.setRawWithoutEvent();
    expect((await f.start()).status).toBe(
      ModeBase.ModeChangeStatus.GenericFailure,
    );
    expect(f.calls).toEqual([]);
  });

  it("preserves legacy starts when no readiness entity is mapped", async () => {
    const f = await fixture("saving_map", false);
    expect((await f.start()).status).toBe(ModeBase.ModeChangeStatus.Success);
    expect(f.calls.map((c) => c.action)).toEqual(["vacuum.start"]);
  });

  it("limits refusal text to Matter's UTF-8 byte limit", async () => {
    const f = await fixture("😀".repeat(40));
    const result = await f.start();
    expect(result.status).toBe(ModeBase.ModeChangeStatus.GenericFailure);
    expect(Buffer.byteLength(result.statusText!)).toBeLessThanOrEqual(64);
    expect(
      Buffer.byteLength(f.op().operationalError.errorStateDetails!),
    ).toBeLessThanOrEqual(64);
    expect(f.calls).toEqual([]);
  });
});

describe("readiness status on the real Server Mode endpoint", () => {
  it("advertises UpdatingMaps only when the readiness mapping is enabled", async () => {
    const f = await fixture();
    expect(f.op().operationalState).toBe(OperationalState.UpdatingMaps);
    expect(f.op().operationalError.errorStateId).toBe(ErrorState.NoError);
    expect(
      f.op().operationalStateList.some((s) => s.operationalStateId === 70),
    ).toBe(true);
    const legacy = await fixture("saving_map", false);
    expect(legacy.op().operationalState).toBe(OperationalState.Docked);
    expect(
      legacy.op().operationalStateList.some((s) => s.operationalStateId === 70),
    ).toBe(false);
  });

  it("updates an existing endpoint when mapping changes, preserving its identity", async () => {
    const f = await fixture("saving_map", false);
    const number = f.endpoint.number;
    const id = f.endpoint.id;
    expect(
      getMappedEntityIds({
        entityId: "vacuum.robot",
        readinessEntity: "sensor.ready",
      }),
    ).toContain("sensor.ready");
    await f.setMapping(true);
    await f.update("saving_map");
    expect(f.op().operationalState).toBe(OperationalState.UpdatingMaps);
    expect(f.endpoint.number).toBe(number);
    expect(f.endpoint.id).toBe(id);
    await f.setMapping(false);
    expect(
      f.endpoint.stateOf(HomeAssistantEntityBehavior).mapping?.readinessEntity,
    ).toBeUndefined();
    await f.update("saving_map");
    expect(f.op().operationalState).toBe(OperationalState.Docked);
    expect(
      f.op().operationalStateList.some((s) => s.operationalStateId === 70),
    ).toBe(false);
  });

  it("clears the stable-ready hold by timer without another HA event", async () => {
    const f = await fixture();
    await f.update("ready", "docked", 4000);
    expect(f.op().operationalState).toBe(OperationalState.UpdatingMaps);
    await vi.waitFor(
      () => {
        expect(f.op().operationalState).toBe(OperationalState.Docked);
      },
      { timeout: 2500, interval: 25 },
    );
  });

  it("still rechecks when the hold expires between the status reads", async () => {
    const f = await fixture();
    const read = VacuumReadiness.prototype.read;
    let n = 0;
    // First read 1 ms before the five-second hold ends, later reads after it.
    const spy = vi
      .spyOn(VacuumReadiness.prototype, "read")
      .mockImplementation(function (this: VacuumReadiness, state, snap) {
        return read.call(
          this,
          state,
          snap,
          Date.parse(snap?.last_changed ?? "") + 4999 + n++,
        );
      });
    try {
      await f.update("ready");
    } finally {
      spy.mockRestore();
    }
    expect(n).toBeGreaterThanOrEqual(3);
    await vi.waitFor(
      () => {
        expect(f.op().operationalState).toBe(OperationalState.Docked);
      },
      { timeout: 1000, interval: 25 },
    );
  });

  it("keeps a completed mission successful when readiness blocks the next one", async () => {
    const f = await fixture();
    const completions: number[] = [];
    f.endpoint
      .eventsOf(RvcOperationalStateServer)
      .operationCompletion?.on((payload) => {
        completions.push(payload.completionErrorCode);
      });
    await f.update("ready", "returning");
    await f.update("bin_full", "docked");
    expect(f.op().operationalError.errorStateId).toBe(
      ErrorState.UnableToStartOrResume,
    );
    expect(completions).toEqual([ErrorState.NoError]);
    await f.update("ready");
    expect(f.op().operationalError.errorStateId).toBe(ErrorState.NoError);
  });
});
