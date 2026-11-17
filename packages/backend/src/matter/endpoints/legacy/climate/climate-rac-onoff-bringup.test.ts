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

// A climate with FAN_MODE is a RoomAirConditioner, which always carries OnOff.
// Without TURN_ON/TURN_OFF or with an opt-out that OnOff used to be the plain
// matter.js one: stuck at false and never sent to HA.

const DEVICE = "rac-dev";
let CLIMATE = "climate.rac";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let calls: string[] = [];

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

function climateState(
  value: string,
  supportedFeatures: number,
): HomeAssistantEntityState {
  const attributes: Record<string, unknown> = {
    friendly_name: "AC",
    hvac_modes: ["off", "heat", "cool"],
    fan_modes: ["low", "high"],
    fan_mode: "low",
    min_temp: 7,
    max_temp: 35,
    temperature: 21,
    current_temperature: 22,
    supported_features: supportedFeatures,
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

function registry(state: HomeAssistantEntityState): BridgeRegistry {
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "AC" } },
    entities: { [CLIMATE]: registryEntity(CLIMATE) },
    labels: [],
    states: { [CLIMATE]: state },
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-racclimate-"));
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

// TARGET_TEMPERATURE | FAN_MODE, plus TURN_OFF | TURN_ON
const FAN_ONLY = 9;
const FAN_AND_POWER = 9 | 128 | 256;

async function mount(
  supportedFeatures: number,
  mapping?: Partial<EntityMappingConfig>,
): Promise<LegacyEndpoint> {
  CLIMATE = `climate.rac${counter}`;
  const endpoint = await LegacyEndpoint.create(
    registry(climateState("heat", supportedFeatures)),
    CLIMATE,
    { entityId: CLIMATE, ...mapping },
  );
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `racclimate-node-${counter++}`,
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

// biome-ignore lint/suspicious/noExplicitAny: read cluster state
const onOff = (endpoint: LegacyEndpoint) => (endpoint.state as any).onOff.onOff;

describe("RoomAirConditioner OnOff mirrors HA", () => {
  it("reads on while HA heats without TURN_ON/TURN_OFF, commands send nothing", async () => {
    const endpoint = await mount(FAN_ONLY);
    expect(onOff(endpoint)).toBe(true);
    // same FeatureMap as the matter.js RoomAirConditioner default
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).onOff.featureMap).toMatchObject({
      deadFrontBehavior: true,
      lighting: false,
    });
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.off());
    expect(calls).toEqual([]);
    expect(onOff(endpoint)).toBe(true);

    await endpoint.updateStates({ [CLIMATE]: climateState("off", FAN_ONLY) });
    await delay(50);
    expect(onOff(endpoint)).toBe(false);
  });

  it("climateBlockOff keeps Off from HA and still turns on", async () => {
    const endpoint = await mount(FAN_AND_POWER, { climateBlockOff: true });
    expect(onOff(endpoint)).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.off());
    expect(calls).toEqual([]);
    expect(onOff(endpoint)).toBe(true);

    await endpoint.updateStates({
      [CLIMATE]: climateState("off", FAN_AND_POWER),
    });
    await delay(50);
    expect(onOff(endpoint)).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());
    expect(calls).toEqual(["climate.turn_on"]);
  });

  it("disableClimateOnOff mirrors HA and sends nothing", async () => {
    const endpoint = await mount(FAN_AND_POWER, { disableClimateOnOff: true });
    expect(onOff(endpoint)).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.off());
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    await endpoint.act((agent: any) => agent.onOff.on());
    expect(calls).toEqual([]);
  });
});
