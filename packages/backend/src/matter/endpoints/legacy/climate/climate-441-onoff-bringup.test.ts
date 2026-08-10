import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import type { HomeAssistantRegistry } from "../../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #441: the turnOn guard only looked at the cached HA state. After a Matter
// power-off the cluster reads false but the HA cache can still say "heat",
// so the next power-on was dropped without a trace. The guard now follows
// the cluster's own attribute and the skip leaves a debug line.

const DEVICE = "ac-dev";
// Unique per test: the optimistic on/off map in on-off-server is module
// global and keyed by entity id, a shared id would leak between tests.
let CLIMATE = "climate.ac";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let calls: string[] = [];
let captured: string[] = [];
let restoreWrite: (() => void) | undefined;
let prevLevel: unknown;

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    area_id: null,
    categories: {},
    device_id: DEVICE,
    disabled_by: null,
    entity_category: null,
    entity_id: entityId,
    has_entity_name: false,
    hidden_by: null,
    id: entityId,
    labels: [],
    name: null,
    original_name: entityId,
    platform: "test",
    translation_key: null,
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}

function climateState(value: string): HomeAssistantEntityState {
  const attributes: Record<string, unknown> = {
    friendly_name: "AC",
    hvac_modes: ["off", "heat"],
    min_temp: 7,
    max_temp: 35,
    temperature: 21,
    current_temperature: 22,
    // TARGET_TEMPERATURE | TURN_OFF | TURN_ON
    supported_features: 385,
  };
  return {
    entity_id: CLIMATE,
    state: value,
    attributes,
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
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
  } as any);
}

function registry(value: string): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [CLIMATE]: climateState(value),
  };
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "AC" } },
    entities: { [CLIMATE]: registryEntity(CLIMATE) },
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-441climate-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action.action);
    },
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);

  captured = [];
  prevLevel = Logger.level;
  Logger.level = "debug";
  const dest = Logger.destinations.default;
  const orig = dest.write;
  dest.write = (text: string, message: unknown) => {
    captured.push(text);
    orig?.(text, message as never);
  };
  restoreWrite = () => {
    dest.write = orig;
  };
});

afterEach(async () => {
  restoreWrite?.();
  Logger.level = prevLevel as never;
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(value: string): Promise<LegacyEndpoint> {
  CLIMATE = `climate.ac${counter}`;
  const endpoint = await LegacyEndpoint.create(registry(value), CLIMATE);
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `441climate-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint!);
  await delay(50);
  return endpoint!;
}

describe("climate OnOff power-on guard (#441)", () => {
  it("honours a power-on after a Matter power-off while the HA cache lags", async () => {
    const endpoint = await mount("heat");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).onOff.onOff).toBe(true);

    // Matter power-off; HA has not confirmed yet, the cache still says "heat".
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.off());
    expect(calls).toContain("climate.turn_off");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).onOff.onOff).toBe(false);

    // The endpoint presents as off, so this on() is a genuine power-on.
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());
    expect(calls).toContain("climate.turn_on");
  });

  it("dispatches a retry on() while the optimistic holdback masks a failed turn-on", async () => {
    const endpoint = await mount("off");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).onOff.onOff).toBe(false);

    // First power-on dispatches, the optimistic write flips the cluster on.
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());
    expect(calls).toContain("climate.turn_on");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).onOff.onOff).toBe(true);

    // HA never confirmed, the cache still says "off": the device is off.
    // The controller retry must dispatch again, not be swallowed.
    calls = [];
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());
    expect(calls).toContain("climate.turn_on");
  });

  it("still skips the redundant on() while genuinely on, with a debug line", async () => {
    const endpoint = await mount("heat");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).onOff.onOff).toBe(true);

    captured = [];
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());

    // No blind climate.turn_on that would flip Homematic AUTO to MANUAL (#269).
    expect(calls).not.toContain("climate.turn_on");
    const skipLines = captured.filter(
      (t) =>
        t.includes("Skipping redundant OnOff.on()") && t.includes('"heat"'),
    );
    expect(skipLines).toHaveLength(1);
  });
});
