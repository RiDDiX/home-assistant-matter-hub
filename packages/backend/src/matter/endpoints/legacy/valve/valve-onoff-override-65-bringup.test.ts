import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityInformation,
  MatterDeviceType,
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
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

// #65: a valve.* entity overridden to a plain on/off device skips the valve
// domain factory, so on/off used to fall back to homeassistant.turn_on/off,
// which HA drops for the valve domain (no turn_on/turn_off service). The fix
// routes those overrides to valve.open_valve / valve.close_valve instead.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-valve65-"));
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

function entity(entityId: string): HomeAssistantEntityInformation {
  const state = {
    entity_id: entityId,
    state: "closed",
    attributes: { friendly_name: "Valve" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: state as any };
}

// Distinct entity ids per case, the optimistic onOff map is keyed per entity.
async function mount(entityId: string, matterDeviceType: MatterDeviceType) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `valve65-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const type = createLegacyEndpointType(entity(entityId), {
    entityId,
    matterDeviceType,
  });
  if (!type) {
    throw new Error("no endpoint type");
  }
  const endpoint = new Endpoint(type, { id: "valve" });
  await aggregator.add(endpoint);
  return endpoint;
}

describe("valve on/off override routes to valve services (#65)", () => {
  it("uses valve.open_valve/close_valve for an on_off_plugin_unit override", async () => {
    const endpoint = await mount("valve.plugin_a", "on_off_plugin_unit");
    calls.length = 0;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      const a = agent as any;
      a.onOff.on();
      a.onOff.off();
    });

    const actions = calls.map((c) => c.action);
    expect(actions.filter((a) => a.startsWith("valve."))).toEqual([
      "valve.open_valve",
      "valve.close_valve",
    ]);
    expect(actions).not.toContain("homeassistant.turn_on");
    expect(actions).not.toContain("homeassistant.turn_off");
  });

  it("uses valve.open_valve/close_valve for an on_off_switch override", async () => {
    const endpoint = await mount("valve.switch_b", "on_off_switch");
    calls.length = 0;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      const a = agent as any;
      a.onOff.on();
      a.onOff.off();
    });

    const actions = calls.map((c) => c.action);
    expect(actions.filter((a) => a.startsWith("valve."))).toEqual([
      "valve.open_valve",
      "valve.close_valve",
    ]);
    expect(actions).not.toContain("homeassistant.turn_on");
    expect(actions).not.toContain("homeassistant.turn_off");
  });

  it("still uses homeassistant.turn_on for a switch entity override", async () => {
    const endpoint = await mount("switch.plugin_c", "on_off_plugin_unit");
    calls.length = 0;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (agent as any).onOff.on();
    });

    expect(calls.map((c) => c.action)).toContain("homeassistant.turn_on");
  });
});
