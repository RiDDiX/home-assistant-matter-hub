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

// #406: on Alexa "open/close" and "set to N%" both arrive as goToLiftPercentage
// with opposite polarity. The BRIDGE coverSwapOpenClose fixes open/close but also
// un-inverts the percentage, so neither setting satisfies both. A PER-ENTITY
// coverSwapOpenClose swaps only the open/close action: the percentage path reads
// bridge flags only, so per-cover swap + default inversion gets both right. This
// locks it - piping per-entity flags into the % path would re-break #406 here.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-cover406-"));
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
      current_position: 50,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "cover.blind", state: state as any };
}

async function mount(supportedFeatures: number, mapping: EntityMappingConfig) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `cover406-node-${counter++}`,
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

// open + close + set_position.
const LIFT_WITH_POSITION = 1 + 2 + 4; // 7

describe("per-entity coverSwapOpenClose swaps open/close, not percentage (#406)", () => {
  it("keeps set-position inverted while swapping open/close", async () => {
    const endpoint = await mount(LIFT_WITH_POSITION, {
      entityId: "cover.blind",
      coverSwapOpenClose: true,
    });

    // "set to 65% open" -> Alexa sends goToLiftPercentage 3500 (35% closed).
    calls.length = 0;
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      const a = agent as any;
      await a.windowCovering.goToLiftPercentage({
        liftPercent100thsValue: 3500,
      });
    });
    await delay(500); // set_cover_position debounces
    const setPos = calls.find((c) => c.action === "cover.set_cover_position");
    // % path reads bridge flags only, so per-entity swap must NOT un-invert it:
    // Matter 35% closed -> HA 65% open.
    expect((setPos?.data as { position?: number }).position).toBe(65);

    // "open" -> goToLiftPercentage 10000, routed to close handler; swap flips it.
    calls.length = 0;
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      const a = agent as any;
      await a.windowCovering.goToLiftPercentage({
        liftPercent100thsValue: 10000,
      });
    });
    expect(calls.map((c) => c.action)).toContain("cover.open_cover");

    // "close" -> goToLiftPercentage 0, routed to open handler; swap flips it.
    calls.length = 0;
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      const a = agent as any;
      await a.windowCovering.goToLiftPercentage({ liftPercent100thsValue: 0 });
    });
    expect(calls.map((c) => c.action)).toContain("cover.close_cover");
  });
});
