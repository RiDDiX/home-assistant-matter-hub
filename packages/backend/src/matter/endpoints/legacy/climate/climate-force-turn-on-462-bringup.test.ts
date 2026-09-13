import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
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

// #462: IR controlled ACs are one way. HA reports the state it last sent, so
// the "already on, skip climate.turn_on" guard can leave a physically off AC
// off. climateForceTurnOn sends the command every time.

const DEVICE = "ir-ac-dev";
// module global optimistic on/off map is keyed by entity id, keep them unique
let CLIMATE = "climate.ir_ac";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let calls: string[] = [];

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    device_id: DEVICE,
    disabled_by: null,
    entity_id: entityId,
    id: entityId,
    labels: [],
    name: null,
    original_name: entityId,
    platform: "test",
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}

function climateState(value: string): HomeAssistantEntityState {
  const attributes: Record<string, unknown> = {
    friendly_name: "IR AC",
    hvac_modes: ["off", "cool"],
    min_temp: 16,
    max_temp: 30,
    temperature: 22,
    current_temperature: 24,
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
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "IR AC" } },
    entities: { [CLIMATE]: registryEntity(CLIMATE) },
    labels: [],
    states: { [CLIMATE]: climateState(value) },
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-462climate-"));
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
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(mapping?: Partial<EntityMappingConfig>) {
  CLIMATE = `climate.ir_ac${counter}`;
  const endpoint = await LegacyEndpoint.create(registry("cool"), CLIMATE, {
    entityId: CLIMATE,
    ...mapping,
  });
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `462climate-node-${counter++}`,
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

describe("#462 forced climate.turn_on", () => {
  it("skips the redundant turn_on by default", async () => {
    const endpoint = await mount();
    calls = [];

    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());

    expect(calls).not.toContain("climate.turn_on");
  });

  it("sends the turn_on on every On command when forced", async () => {
    const endpoint = await mount({ climateForceTurnOn: true });
    calls = [];

    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());

    expect(calls.filter((c) => c === "climate.turn_on")).toHaveLength(2);
  });
});
