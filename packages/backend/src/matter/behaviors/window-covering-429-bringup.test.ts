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
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { WindowCovering } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
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
});

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

let seq = 0;

function coverEntity(
  stateStr: string,
  haPosition: number,
): HomeAssistantEntityInformation {
  seq += 1;
  const state = {
    entity_id: "cover.blind",
    state: stateStr,
    attributes: {
      friendly_name: "Blind",
      supported_features: LIFT_WITH_POSITION,
      current_position: haPosition,
    },
    context: { id: `ctx-${seq}` },
    last_changed: `2026-01-01T00:00:${String(seq).padStart(2, "0")}`,
    last_updated: `2026-01-01T00:00:${String(seq).padStart(2, "0")}`,
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "cover.blind", state: state as any };
}

async function mount(stateStr: string, haPosition: number) {
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
    CoverDevice({ entity: coverEntity(stateStr, haPosition) } as never),
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
function subscribe(endpoint: Endpoint): Capture {
  const cap: Capture = { ops: [], currents: [], targets: [] };
  // biome-ignore lint/suspicious/noExplicitAny: read events proxy off endpoint
  const wc = (endpoint.events as any).windowCovering;
  wc.operationalStatus$Changed.on((v: { global?: number }) => {
    cap.ops.push(v?.global);
  });
  wc.currentPositionLiftPercent100ths$Changed.on((v: number | null) => {
    cap.currents.push(v);
  });
  wc.targetPositionLiftPercent100ths$Changed.on((v: number | null) => {
    cap.targets.push(v);
  });
  return cap;
}

async function drive(endpoint: Endpoint, stateStr: string, haPosition: number) {
  await endpoint.setStateOf(HomeAssistantEntityBehavior, {
    entity: coverEntity(stateStr, haPosition),
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

async function upOrOpen(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive controller command
    const a = agent as any;
    await a.windowCovering.upOrOpen({});
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

  it("e: optimistic move that never completes flips to Stopped after the timeout", async () => {
    setOptimisticMovementTimeoutMsForTests(800);
    const endpoint = await mount("closed", 0);
    const cap = subscribe(endpoint);

    await goToLift(endpoint, 0); // target Matter 0 (open)
    // HA reports a stopped state ('open') but a position that never reaches the
    // target, so completion can't be inferred from current == target.
    await drive(endpoint, "open", 50); // Matter current 5000, still != 0
    expect(cap.ops).toEqual([Opening]); // still optimistically Opening, not expired

    await delay(1200); // past the 800ms safety timeout
    await drive(endpoint, "open", 50); // next HA tick evaluates the timeout

    expect(cap.ops).toEqual([Opening, Stopped]);
  });

  it("f: HA lands off-target then goes quiet -> the safety timer emits Stopped with no further HA tick", async () => {
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

    await delay(1200); // past the 800ms timeout, NO further HA drive
    expect(cap.ops).toEqual([Opening, Stopped]);
    // Stopped requires target = current, so the timer snaps the stale target.
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const wc = (endpoint.state as any).windowCovering;
    expect(wc.targetPositionLiftPercent100ths).toBe(6000);
    expect(wc.currentPositionLiftPercent100ths).toBe(6000);
  });

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
