// Bringup / regression guard for issue #464, second round. Serializing our own
// writes per endpoint (alpha.879) stopped two Home Assistant updates from
// colliding with each other, but the reporter still lost positions when the
// blocker was the controller's own session transaction. The update reactors
// never declared the lock they need, so the first attribute write took it
// synchronously and matter.js threw the whole patch away with a warning.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, Logger, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { CoverDevice } from "../endpoints/legacy/cover/index.js";
import { updateEntityState } from "../endpoints/update-entity-state.js";

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-cover464-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
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
  restoreLog?.();
  restoreLog = undefined;
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

// open + close + set_position
const LIFT_WITH_POSITION = 1 + 2 + 4;

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

async function mount(haPosition: number) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `cover464-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    CoverDevice({ entity: coverEntity("open", haPosition) } as never),
    { id: "blind" },
  );
  await aggregator.add(endpoint);
  return endpoint;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let restoreLog: (() => void) | undefined;

// Tap the default destination the same way the #429 harness does.
function captureLogs(): string[] {
  const captured: string[] = [];
  const dest = Logger.destinations.default;
  const orig = dest.write;
  dest.write = (text: string, message: unknown) => {
    captured.push(text);
    orig?.(text, message as never);
  };
  restoreLog = () => {
    dest.write = orig;
  };
  return captured;
}

function liftPosition(endpoint: Endpoint): number | null {
  // biome-ignore lint/suspicious/noExplicitAny: read state off endpoint
  return (endpoint.state as any).windowCovering
    .currentPositionLiftPercent100ths;
}

/**
 * Hold the WindowCovering lock the way an in-flight controller interaction
 * does, and resolve once the caller releases it.
 */
async function holdWindowCoveringLock(endpoint: Endpoint) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const held = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: behavior doubles as resource
    const behavior = (agent as any).windowCovering;
    agent.context.transaction.addResourcesSync(behavior);
    await agent.context.transaction.begin();
    locked();
    await gate;
  });
  await held;
  return async () => {
    release();
    await holder;
  };
}

describe("#464 state writes wait for a blocked endpoint lock", () => {
  it("lands the position after a foreign transaction releases the lock", async () => {
    const endpoint = await mount(0);
    expect(liftPosition(endpoint)).toBe(10000);
    const logs = captureLogs();

    const release = await holdWindowCoveringLock(endpoint);
    const update = updateEntityState(endpoint, coverEntity("open", 69).state);
    await delay(50);

    await release();
    await update;
    await delay(30);

    expect(liftPosition(endpoint)).toBe(3100);
    expect(logs.join("\n")).not.toContain("DROPPED");
  });

  // The wait only works while the entity observable reports itself as async.
  // matter.js hands out a proxy that drops that flag, so HomeAssistantEntityBehavior
  // puts it back; without it every non-offline update reactor throws an
  // ImplementationError on the hot Home Assistant path instead of writing.
  it("keeps the entity observable async so a reactor may wait", async () => {
    const endpoint = await mount(0);
    const isAsync = await endpoint.act(
      // biome-ignore lint/suspicious/noExplicitAny: read the behavior off the agent
      (agent) => (agent as any).homeAssistantEntity.onChange.isAsync,
    );
    expect(isAsync).toBe(true);
  });
});
