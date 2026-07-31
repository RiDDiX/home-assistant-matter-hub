// Bringup / regression guard for issue #429 (SONOFF MINI-RBS via SonoffLAN ->
// Alexa Echo Show stuck on "Opening"). When a Matter controller starts a move
// but the HA integration never surfaces an opening/closing transitional state,
// the cover previously emitted ZERO operationalStatus reports, so the controller
// never got the moving->stopped edge that clears its optimistic label. This file
// pins the optimistic-movement fix: a command writes Opening/Closing immediately
// and the following HA event (or StopMotion, or a safety timeout) writes Stopped.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BridgeFeatureFlags,
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { WindowCovering } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { CoverDevice } from "../endpoints/legacy/cover/index.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import {
  DEFAULT_OPTIMISTIC_MOVEMENT_TIMEOUT_MS,
  setOptimisticMovementTimeoutMsForTests,
} from "./window-covering-server.js";

const Stopped = WindowCovering.MovementStatus.Stopped;
const Opening = WindowCovering.MovementStatus.Opening;
const Closing = WindowCovering.MovementStatus.Closing;

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-cover429b-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  setFeatureFlags(undefined);
});

// Re-set the provider so a test can pick a controller profile's flags before
// mounting (the Alexa profile ships coverUseHomeAssistantPercentage).
function setFeatureFlags(
  featureFlags: Partial<BridgeFeatureFlags> | undefined,
) {
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      featureFlags,
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "t",
        productName: "t",
        productLabel: "t",
        hardwareVersion: 1,
        softwareVersion: 1,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any),
  );
}

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  setOptimisticMovementTimeoutMsForTests(
    DEFAULT_OPTIMISTIC_MOVEMENT_TIMEOUT_MS,
  );
  rmSync(dir, { recursive: true, force: true });
});

// open + close + set_position => Lift + PositionAwareLift, no tilt (SONOFF MINI-RBS).
const LIFT_WITH_POSITION = 1 + 2 + 4; // 7
// ... plus open_tilt + close_tilt + set_tilt_position => Tilt + PositionAwareTilt
// with the discrete open_cover_tilt / close_cover_tilt services.
const LIFT_AND_TILT_WITH_POSITION = LIFT_WITH_POSITION + 16 + 32 + 128; // 183
// open + close + stop, no set_position: a percentage lands on open/close instead.
const BINARY_COVER = 1 + 2 + 8; // 11

// Entity shape beyond the default lift-with-position blind.
interface Fixture {
  supportedFeatures?: number;
  haTiltPosition?: number;
}

let seq = 0;

function coverEntity(
  stateStr: string,
  haPosition: number,
  fixture: Fixture = {},
): HomeAssistantEntityInformation {
  seq += 1;
  const state = {
    entity_id: "cover.blind",
    state: stateStr,
    attributes: {
      friendly_name: "Blind",
      supported_features: fixture.supportedFeatures ?? LIFT_WITH_POSITION,
      current_position: haPosition,
      ...(fixture.haTiltPosition != null
        ? { current_tilt_position: fixture.haTiltPosition }
        : {}),
    },
    context: { id: `ctx-${seq}` },
    last_changed: `2026-01-01T00:00:${String(seq).padStart(2, "0")}`,
    last_updated: `2026-01-01T00:00:${String(seq).padStart(2, "0")}`,
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "cover.blind", state: state as any };
}

async function mount(
  stateStr: string,
  haPosition: number,
  mapping?: EntityMappingConfig,
  fixture?: Fixture,
) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `cover429b-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    CoverDevice({
      entity: coverEntity(stateStr, haPosition, fixture),
      ...(mapping ? { mapping } : {}),
    } as never),
    { id: "blind" },
  );
  await aggregator.add(endpoint);
  return endpoint;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Capture {
  ops: (number | undefined)[];
  currents: (number | null)[];
  targets: (number | null)[];
}

// Subscribe AFTER mount so the initial mount-time Stopped write is not counted.
// currents/targets follow one axis; the tilt attrs exist on tilt covers only.
function subscribe(
  endpoint: Endpoint,
  axis: "lift" | "tilt" = "lift",
): Capture {
  const cap: Capture = { ops: [], currents: [], targets: [] };
  // biome-ignore lint/suspicious/noExplicitAny: read events proxy off endpoint
  const wc = (endpoint.events as any).windowCovering;
  wc.operationalStatus$Changed.on((v: { global?: number }) => {
    cap.ops.push(v?.global);
  });
  const current$ =
    axis === "lift"
      ? wc.currentPositionLiftPercent100ths$Changed
      : wc.currentPositionTiltPercent100ths$Changed;
  const target$ =
    axis === "lift"
      ? wc.targetPositionLiftPercent100ths$Changed
      : wc.targetPositionTiltPercent100ths$Changed;
  current$.on((v: number | null) => {
    cap.currents.push(v);
  });
  target$.on((v: number | null) => {
    cap.targets.push(v);
  });
  return cap;
}

async function drive(
  endpoint: Endpoint,
  stateStr: string,
  haPosition: number,
  fixture?: Fixture,
) {
  await endpoint.setStateOf(HomeAssistantEntityBehavior, {
    entity: coverEntity(stateStr, haPosition, fixture),
  });
  await delay(30);
}

async function goToLift(endpoint: Endpoint, liftPercent100thsValue: number) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive controller command
    const a = agent as any;
    await a.windowCovering.goToLiftPercentage({ liftPercent100thsValue });
  });
  await delay(30);
}

async function goToTilt(endpoint: Endpoint, tiltPercent100thsValue: number) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive controller command
    const a = agent as any;
    await a.windowCovering.goToTiltPercentage({ tiltPercent100thsValue });
  });
  await delay(30);
}

async function upOrOpen(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive controller command
    const a = agent as any;
    await a.windowCovering.upOrOpen({});
  });
  await delay(30);
}

async function downOrClose(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive controller command
    const a = agent as any;
    await a.windowCovering.downOrClose({});
  });
  await delay(30);
}

async function stopMotion(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive controller command
    const a = agent as any;
    await a.windowCovering.stopMotion({});
  });
  await delay(30);
}

// biome-ignore lint/suspicious/noExplicitAny: read cluster state off endpoint
function state(endpoint: Endpoint): any {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state off endpoint
  return (endpoint.state as any).windowCovering;
}

describe("#429 optimistic movement bringup", () => {
  it("a: goToLiftPercentage(0) then a single HA 'open' emits Opening then Stopped", async () => {
    const endpoint = await mount("closed", 0); // HA 0 = Matter 10000 (closed)
    const cap = subscribe(endpoint);

    await goToLift(endpoint, 0); // Alexa open
    await drive(endpoint, "open", 100); // HA completes, never says "opening"

    expect(cap.ops).toEqual([Opening, Stopped]);
    expect(state(endpoint).currentPositionLiftPercent100ths).toBe(0);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(0);
  });

  it("b: boundary UpOrOpen command (target 0) emits Opening then Stopped", async () => {
    const endpoint = await mount("closed", 0);
    const cap = subscribe(endpoint);

    await upOrOpen(endpoint);
    await drive(endpoint, "open", 100);

    expect(cap.ops).toEqual([Opening, Stopped]);
    expect(state(endpoint).currentPositionLiftPercent100ths).toBe(0);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(0);
  });

  it("c: StopMotion after a command emits Stopped and clears the optimistic entry", async () => {
    const endpoint = await mount("closed", 0);
    const cap = subscribe(endpoint);

    await goToLift(endpoint, 0);
    await stopMotion(endpoint);

    expect(cap.ops).toEqual([Opening, Stopped]);
    // Optimistic cleared: a later HA 'open' at target must NOT re-open the move.
    cap.ops.length = 0;
    await drive(endpoint, "open", 100);
    expect(cap.ops).not.toContain(Opening);
  });

  it("d: HA transitional states still win (closed -> closing -> closed)", async () => {
    const endpoint = await mount("closed", 0);
    const cap = subscribe(endpoint);

    await drive(endpoint, "closing", 50);
    await drive(endpoint, "closed", 0);

    // Closing then Stopped, exactly two emissions, no optimistic double-fire.
    expect(cap.ops).toEqual([Closing, Stopped]);
  });

  it(
    "e: optimistic move that never completes flips to Stopped after the timeout",
    { retry: 2, timeout: 20_000 },
    async () => {
      setOptimisticMovementTimeoutMsForTests(800);
      const endpoint = await mount("closed", 0);
      const cap = subscribe(endpoint);

      await goToLift(endpoint, 0); // target Matter 0 (open)
      // HA reports a stopped state ('open') but a position that never reaches the
      // target, so completion can't be inferred from current == target.
      await drive(endpoint, "open", 50); // Matter current 5000, still != 0
      expect(cap.ops).toEqual([Opening]); // still optimistically Opening, not expired

      // Poll generously: parallel suite load can starve this worker for seconds.
      await vi.waitFor(() => expect(cap.ops).toContain(Stopped), {
        timeout: 15_000,
      });
      await drive(endpoint, "open", 50); // next HA tick evaluates the timeout

      expect(cap.ops).toEqual([Opening, Stopped]);
    },
  );

  it(
    "f: HA lands off-target then goes quiet -> the safety timer emits Stopped with no further HA tick",
    { retry: 2, timeout: 20_000 },
    async () => {
      // Finding 1: the passive expiry only runs inside update() on the next HA
      // onChange. If HA falls silent after parking off the exact target, the
      // moving label must still clear on its own via the active timer.
      setOptimisticMovementTimeoutMsForTests(800);
      const endpoint = await mount("closed", 0); // Matter current/target 10000
      const cap = subscribe(endpoint);

      await goToLift(endpoint, 5000); // mid-range target
      // HA finishes but reports a position 1000 100ths off the target and then
      // never ticks again. Not reached, not yet expired -> still Opening.
      await drive(endpoint, "open", 40); // HA 40 => Matter 6000, state 'open'
      expect(cap.ops).toEqual([Opening]);

      // Poll generously: parallel suite load can starve this worker for seconds.
      await vi.waitFor(() => expect(cap.ops).toContain(Stopped), {
        timeout: 15_000,
      });
      expect(cap.ops).toEqual([Opening, Stopped]);
      // Stopped requires target = current, so the timer snaps the stale target.
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      const wc = (endpoint.state as any).windowCovering;
      expect(wc.targetPositionLiftPercent100ths).toBe(6000);
      expect(wc.currentPositionLiftPercent100ths).toBe(6000);
    },
  );

  it("g: HA lands within 1% of a non-round target -> completion clears via tolerance", async () => {
    // Finding 2: resolveAxisStatus completion used exact ==, so a landing a
    // fraction of a percent off the commanded target never cleared the move.
    // Default timeout so only the tolerance (not the timer) can clear it.
    const endpoint = await mount("closed", 0);
    const cap = subscribe(endpoint);

    await goToLift(endpoint, 5050); // target not a multiple of an HA percent
    await drive(endpoint, "open", 50); // HA 50 => Matter 5000, 50 100ths shy

    expect(cap.ops).toEqual([Opening, Stopped]);
  });
});

// FrancYescO's #429 follow-up: the completion check compared current against the
// Matter target that matter.js pre-writes (WindowCoveringServer.ts:522/:546), but
// the stored current is not always in Matter space. Under the Alexa profile flag
// coverUseHomeAssistantPercentage the read path skips inversion
// (cover-position-utils.ts:17-20), and a per-entity coverSwapOpenClose sends the
// cover to the opposite end without un-inverting the reads
// (cover-window-covering-server.ts:146-152). Both park the axis nowhere near the
// target, so the optimistic status stuck until the 120s timer.
describe("#429 completion in non-Matter position spaces", () => {
  it("h: HA-percentage flag, close completes and target matches current", async () => {
    setFeatureFlags({ coverUseHomeAssistantPercentage: true });
    const endpoint = await mount("open", 100); // no inversion: stored 10000
    const cap = subscribe(endpoint);

    await downOrClose(endpoint); // matter.js pre-writes target 10000
    await drive(endpoint, "closed", 0); // HA 0 => stored 0, not 10000

    expect(cap.ops).toEqual([Closing, Stopped]);
    expect(state(endpoint).currentPositionLiftPercent100ths).toBe(0);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(0);
  });

  it("i: HA-percentage flag, open completes and target matches current", async () => {
    setFeatureFlags({ coverUseHomeAssistantPercentage: true });
    const endpoint = await mount("closed", 0); // no inversion: stored 0
    const cap = subscribe(endpoint);

    await upOrOpen(endpoint); // matter.js pre-writes target 0
    await drive(endpoint, "open", 100); // HA 100 => stored 10000, not 0

    expect(cap.ops).toEqual([Opening, Stopped]);
    expect(state(endpoint).currentPositionLiftPercent100ths).toBe(10000);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(10000);
  });

  it("j: per-entity swap, a Matter close parks the cover open and still completes", async () => {
    const endpoint = await mount("closed", 0, {
      entityId: "cover.blind",
      coverSwapOpenClose: true,
    });
    const cap = subscribe(endpoint);
    calls.length = 0;

    await downOrClose(endpoint); // target 10000
    expect(calls.map((c) => c.action)).toEqual(["cover.open_cover"]);
    await drive(endpoint, "open", 100); // default inversion: stored 0

    expect(cap.ops).toEqual([Closing, Stopped]);
    expect(state(endpoint).currentPositionLiftPercent100ths).toBe(0);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(0);
  });

  it("k: HA-percentage flag, a mid-range percentage move still completes on target", async () => {
    setFeatureFlags({ coverUseHomeAssistantPercentage: true });
    const endpoint = await mount("closed", 0); // stored 0
    const cap = subscribe(endpoint);

    await goToLift(endpoint, 3000);
    await drive(endpoint, "open", 30); // write and read share one involution

    expect(cap.ops).toEqual([Closing, Stopped]);
    expect(state(endpoint).currentPositionLiftPercent100ths).toBe(3000);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(3000);
  });
});

// getMovementStatus resolved the swap from the bridge flag alone while the
// dispatch side (shouldSwapOpenClose) prefers the per-entity mapping. Under a
// per-entity swap a Matter close fires cover.open_cover, HA answers "opening",
// and that transitional state reported Opening on top of the optimistic Closing:
// the controller saw the direction flip mid-move.
describe("#429 swap direction stays consistent through HA transitionals", () => {
  it("p: a mid-move flag edit cannot complete the move across spaces", async () => {
    // The entry stores the HA end, so the goal re-resolves through the live
    // conversion each tick: flipping coverUseHomeAssistantPercentage mid-move
    // must neither stop early nor strand the axis.
    const endpoint = await mount("open", 100);
    const cap = subscribe(endpoint);

    await downOrClose(endpoint);
    expect(cap.ops).toEqual([Closing]);

    // Bridge edit mid-move: same env, new flags.
    setFeatureFlags({ coverUseHomeAssistantPercentage: true });
    // Still fully open; in the new space current stores 10000, which equals the
    // pre-written Matter target and would false-complete a frozen number.
    await drive(endpoint, "open", 100);
    expect(cap.ops).toEqual([Closing]);

    // HA lands closed: position 0 stores 0 in the new space, close end matches.
    await drive(endpoint, "closed", 0);
    expect(cap.ops).toEqual([Closing, Stopped]);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(
      state(endpoint).currentPositionLiftPercent100ths,
    );
  });

  it("l: per-entity swap, an HA transitional keeps the Matter close direction", async () => {
    const endpoint = await mount("closed", 0, {
      entityId: "cover.blind",
      coverSwapOpenClose: true,
    });
    const cap = subscribe(endpoint);
    calls.length = 0;

    await downOrClose(endpoint); // Matter close, swapped to the open service
    expect(calls.map((c) => c.action)).toEqual(["cover.open_cover"]);
    await drive(endpoint, "opening", 50); // HA reports the un-swapped direction
    await drive(endpoint, "open", 100);

    // The transitional confirms the same Matter direction, so nothing is
    // re-emitted between the optimistic Closing and the landing.
    expect(cap.ops).toEqual([Closing, Stopped]);
    expect(state(endpoint).currentPositionLiftPercent100ths).toBe(0);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(0);
  });
});

// Same two spaces as h-k, driven on the tilt axis. Lift and tilt share
// adjustPositionForReading and expectedRestPosition, and these pin that.
describe("#429 tilt axis in non-Matter position spaces", () => {
  it("m: HA-percentage flag, a boundary tilt close completes on the HA end", async () => {
    setFeatureFlags({ coverUseHomeAssistantPercentage: true });
    const endpoint = await mount("open", 100, undefined, {
      supportedFeatures: LIFT_AND_TILT_WITH_POSITION,
      haTiltPosition: 100, // no inversion: stored 10000
    });
    const cap = subscribe(endpoint, "tilt");
    calls.length = 0;

    await goToTilt(endpoint, 10000); // boundary, matter.js pre-writes target 10000
    expect(calls.map((c) => c.action)).toEqual(["cover.close_cover_tilt"]);
    await drive(endpoint, "closed", 0, {
      supportedFeatures: LIFT_AND_TILT_WITH_POSITION,
      haTiltPosition: 0, // HA 0 => stored 0, not the pre-written 10000
    });

    expect(cap.ops).toEqual([Closing, Stopped]);
    expect(state(endpoint).currentPositionTiltPercent100ths).toBe(0);
    expect(state(endpoint).targetPositionTiltPercent100ths).toBe(0);
  });

  it("n: per-entity swap, a Matter tilt close fires open_cover_tilt and completes", async () => {
    const endpoint = await mount(
      "closed",
      0,
      { entityId: "cover.blind", coverSwapOpenClose: true },
      {
        supportedFeatures: LIFT_AND_TILT_WITH_POSITION,
        haTiltPosition: 0, // default inversion: stored 10000
      },
    );
    const cap = subscribe(endpoint, "tilt");
    calls.length = 0;

    await goToTilt(endpoint, 10000);
    expect(calls.map((c) => c.action)).toEqual(["cover.open_cover_tilt"]);
    await drive(endpoint, "open", 100, {
      supportedFeatures: LIFT_AND_TILT_WITH_POSITION,
      haTiltPosition: 100, // the swapped service parks tilt open: stored 0
    });

    expect(cap.ops).toEqual([Closing, Stopped]);
    expect(state(endpoint).currentPositionTiltPercent100ths).toBe(0);
    expect(state(endpoint).targetPositionTiltPercent100ths).toBe(0);
  });
});

describe("#429 binary cover percentage moves", () => {
  it("o: mid-range percentage on a binary cover resolves on the HA landing", async () => {
    // Pins an intentional improvement: a cover without set_position turns a
    // percentage into open/close, so it parks at an end and never at the
    // commanded target. Before the rest-position expectation that mismatch held
    // the optimistic status for the full 120s timeout.
    const endpoint = await mount("closed", 0, undefined, {
      supportedFeatures: BINARY_COVER,
    });
    const cap = subscribe(endpoint);
    calls.length = 0;

    await goToLift(endpoint, 3000); // Matter 3000 => HA 70 => open
    await delay(500); // past the slider debounce
    expect(calls.map((c) => c.action)).toEqual(["cover.open_cover"]);
    await drive(endpoint, "open", 100, { supportedFeatures: BINARY_COVER });

    expect(cap.ops).toEqual([Opening, Stopped]);
    // At rest the axis snaps to where HA actually parked, target following.
    expect(state(endpoint).currentPositionLiftPercent100ths).toBe(0);
    expect(state(endpoint).targetPositionLiftPercent100ths).toBe(0);
  });
});
