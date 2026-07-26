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
import { ScriptDevice } from "./index.js";

// #423: script/scene/automation/input_button entities are wired with
// isOn: () => false and turnOff: null. Activating them normally sets an
// optimistic onOff true, then auto-resets to false ~1s later, producing an
// unsolicited on->off report pair per run. Some Echo devices wedge on that
// pair until restarted. disableMomentaryFlip skips both writes: the HA
// action still fires, but the state stays off and nothing ever reports.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-momentary-423-"));
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

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function scriptEntity(entityId: string): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state: "off",
    attributes: { friendly_name: "Morning Routine" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: s as any };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Distinct entity ids per test, the optimistic onOff map is per entity id.
async function mount(entityId: string, mapping?: EntityMappingConfig) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `momentary-423-node-${entityId.replace(/\./g, "-")}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const type = ScriptDevice({
    entity: scriptEntity(entityId),
    mapping,
    // biome-ignore lint/suspicious/noExplicitAny: behavior state fixture
  } as any);
  const endpoint = new Endpoint(type, { id: "scr" });
  await aggregator.add(endpoint);
  return { server, endpoint };
}

describe("disableMomentaryFlip (#423)", () => {
  it("without the flag: flips on then auto-resets off ~1s later (guard)", async () => {
    const { server, endpoint } = await mount("script.evening_routine");

    let onOffImmediately: boolean | undefined;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      const a = agent as any;
      a.onOff.on();
      onOffImmediately = a.onOff.state.onOff;
    });
    expect(onOffImmediately).toBe(true);

    await delay(1200);
    let onOffLater: boolean | undefined;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read state
      onOffLater = (agent as any).onOff.state.onOff;
    });
    await server.close().catch(() => {});

    expect(onOffLater).toBe(false);
    expect(calls.filter((c) => c.action === "script.turn_on")).toHaveLength(1);
  });

  it("with the flag: onOff stays false immediately and after the reset window", async () => {
    const { server, endpoint } = await mount("script.morning_routine", {
      entityId: "script.morning_routine",
      disableMomentaryFlip: true,
    });

    let onOffImmediately: boolean | undefined;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      const a = agent as any;
      a.onOff.on();
      onOffImmediately = a.onOff.state.onOff;
    });
    expect(onOffImmediately).toBe(false);

    await delay(1200);
    let onOffLater: boolean | undefined;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read state
      onOffLater = (agent as any).onOff.state.onOff;
    });
    await server.close().catch(() => {});

    expect(onOffLater).toBe(false);
    expect(calls.filter((c) => c.action === "script.turn_on")).toHaveLength(1);
  });
});
