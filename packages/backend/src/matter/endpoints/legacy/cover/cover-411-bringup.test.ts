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
});
