import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { CoverDevice } from "./index.js";

// #411: matter.js runs each controller command on a fresh behavior instance, so
// the debounce timer and pending action stored on instance fields could never
// be cleared by the next slider command. Two back-to-back goToLiftPercentage
// commands both fired their own set_cover_position action and coverSliderDebounceMs
// did nothing. The fix moves the debounce bookkeeping into an endpoint-keyed
// registry so the second command cancels the first and only the last one fires.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-cover411-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
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
  // Close from afterEach so a failing assertion still tears the server down.
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function coverEntity(
  supportedFeatures: number,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: "cover.blind",
    state: "open",
    attributes: {
      friendly_name: "Blind",
      supported_features: supportedFeatures,
      // Far from both slider targets so neither command is skipped as a no-op.
      current_position: 10,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "cover.blind", state: state as any };
}

async function mount(supportedFeatures: number, mapping?: EntityMappingConfig) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `cover411-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    CoverDevice({ entity: coverEntity(supportedFeatures), mapping } as never),
    { id: "blind" },
  );
  await aggregator.add(endpoint);
  return endpoint;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function slideLift(endpoint: Endpoint, liftPercent100thsValue: number) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    const a = agent as any;
    await a.windowCovering.goToLiftPercentage({ liftPercent100thsValue });
  });
}

// open + close + set_position.
const LIFT_WITH_POSITION = 1 + 2 + 4; // 7

describe("coverSliderDebounceMs collapses back-to-back slider commands (#411)", () => {
  it("fires one set_cover_position for the last target within the window", async () => {
    const endpoint = await mount(LIFT_WITH_POSITION, {
      entityId: "cover.blind",
      coverSliderDebounceMs: 150,
    });

    calls.length = 0;
    // Two slider commands land on two fresh behavior instances, exactly the
    // production path. Before the fix the second could not clear the first
    // timer, so both fired (positions 33 then 49).
    await slideLift(endpoint, 6700);
    await slideLift(endpoint, 5100);
    await delay(400);

    const positionCalls = calls.filter(
      (c) => c.action === "cover.set_cover_position",
    );
    expect(positionCalls).toHaveLength(1);
    // Matter 5100 (51% closed) -> HA 49% open.
    expect((positionCalls[0].data as { position?: number }).position).toBe(49);
  });

  it("two-phase debounce still collapses to one call without an override", async () => {
    const endpoint = await mount(LIFT_WITH_POSITION);

    calls.length = 0;
    await slideLift(endpoint, 6700);
    await slideLift(endpoint, 5100);
    // No override: first command uses DEBOUNCE_INITIAL_MS (400), the second
    // clears it and uses DEBOUNCE_SUBSEQUENT_MS (150). Wait past both.
    await delay(700);

    const positionCalls = calls.filter(
      (c) => c.action === "cover.set_cover_position",
    );
    expect(positionCalls).toHaveLength(1);
    expect((positionCalls[0].data as { position?: number }).position).toBe(49);
  });

  it("lift to 33% followed by lift to 0% results in single cover.open_cover call", async () => {
    // This reproduces the exact scenario from logs:
    // 1. goToLiftPercentage(3300) -> handleGoToLiftPosition(3300) -> schedules debounced set_cover_position(67)
    // 2. goToLiftPercentage(0) -> handleLiftOpen() -> should clear pending action and call cover.open_cover
    // Before the fix: both the debounced set_cover_position and immediate cover.open_cover would fire
    // After the fix: only cover.open_cover should fire
    const endpoint = await mount(LIFT_WITH_POSITION, {
      entityId: "cover.blind",
      // Use a long debounce to ensure the first command would normally fire
      coverSliderDebounceMs: 1200,
    });

    calls.length = 0;

    // First command: lift to 33% (3300 in Matter 100ths)
    // This should schedule a debounced set_cover_position call
    await slideLift(endpoint, 3300);

    // Second command: lift to 0% (fully open)
    // This should trigger handleLiftOpen() which should clear the pending debounced action
    await slideLift(endpoint, 0);

    // Wait long enough for any debounced actions to have fired if they weren't cleared
    await delay(1500);

    // Filter for the actions we care about
    const openCalls = calls.filter((c) => c.action === "cover.open_cover");
    const positionCalls = calls.filter(
      (c) => c.action === "cover.set_cover_position",
    );

    // Should have exactly one open_cover call and no set_cover_position calls
    expect(openCalls).toHaveLength(1);
    expect(positionCalls).toHaveLength(0);
  });

  it("lift to 67% followed by lift to 100% results in single cover.close_cover call", async () => {
    // Test the close boundary as well
    const endpoint = await mount(LIFT_WITH_POSITION, {
      entityId: "cover.blind",
      coverSliderDebounceMs: 1200,
    });

    calls.length = 0;

    // First command: lift to 67% (6700 in Matter 100ths)
    await slideLift(endpoint, 6700);

    // Second command: lift to 100% (fully closed)
    await slideLift(endpoint, 10000);

    // Wait for any debounced actions
    await delay(1500);

    const closeCalls = calls.filter((c) => c.action === "cover.close_cover");
    const positionCalls = calls.filter(
      (c) => c.action === "cover.set_cover_position",
    );

    // Should have exactly one close_cover call and no set_cover_position calls
    expect(closeCalls).toHaveLength(1);
    expect(positionCalls).toHaveLength(0);
  });

  it("stop command clears both lift and tilt pending actions", async () => {
    // Test that stop commands also clear pending actions
    const endpoint = await mount(LIFT_WITH_POSITION, {
      entityId: "cover.blind",
      coverSliderDebounceMs: 1200,
    });

    calls.length = 0;

    // First command: lift to 50%
    await slideLift(endpoint, 5000);

    // Send stop command
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the stop command
      const a = agent as any;
      await a.windowCovering.stopMotion({});
    });

    // Wait for any debounced actions
    await delay(1500);

    const stopCalls = calls.filter((c) => c.action === "cover.stop_cover");
    const positionCalls = calls.filter(
      (c) => c.action === "cover.set_cover_position",
    );

    // Should have exactly one stop_cover call and no set_cover_position calls
    expect(stopCalls).toHaveLength(1);
    expect(positionCalls).toHaveLength(0);
  });
});
