import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BinarySensorDeviceClass,
  type EntityMappingConfig,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { SmokeCoAlarm } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #427 runtime layer: the construction-time strip only cleans the initial
// state. A live state update replaces entity.state with the raw HA state, so
// the smoke alarm's own battery_level attribute comes back and batteryAlert
// flips to non-Normal despite disableBatteryMapping. The battery reader must
// honor the flag on every update, not just at init.

const DEVICE = "dev1";
const SMOKE = "binary_sensor.smoke_alarm";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

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

function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
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
    featureFlags: { autoBatteryMapping: true },
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

// Smoke alarm that carries its own low battery_level attribute.
function registry(batteryLevel: number): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [SMOKE]: state(SMOKE, "off", {
      device_class: BinarySensorDeviceClass.Smoke,
      battery_level: batteryLevel,
    }),
  };
  const entities = Object.fromEntries(
    Object.keys(states).map((id) => [id, registryEntity(id)]),
  );
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Alarm" } },
    entities,
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-427smoke-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
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

async function mount(reg: BridgeRegistry, mapping: EntityMappingConfig) {
  const endpoint = await LegacyEndpoint.create(reg, SMOKE, mapping);
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `427smoke-node-${counter++}`,
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

async function deliver(endpoint: LegacyEndpoint, batteryLevel: number) {
  const states: HomeAssistantStates = {
    [SMOKE]: state(SMOKE, "off", {
      device_class: BinarySensorDeviceClass.Smoke,
      battery_level: batteryLevel,
    }),
  };
  await endpoint.updateStates(states);
  await delay(200);
}

function batteryAlert(endpoint: LegacyEndpoint): SmokeCoAlarm.AlarmState {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state off endpoint
  return (endpoint.state as any).smokeCoAlarm.batteryAlert;
}

describe("disableBatteryMapping smoke runtime (#427)", () => {
  it("keeps batteryAlert Normal at init and after an update carrying battery", async () => {
    const mapping: EntityMappingConfig = {
      entityId: SMOKE,
      disableBatteryMapping: true,
    };
    const endpoint = await mount(registry(5), mapping);
    // Init: construction strips the attribute, so batteryAlert is Normal.
    expect(batteryAlert(endpoint)).toBe(SmokeCoAlarm.AlarmState.Normal);

    // A live update restores battery_level=5 (<=10 -> Critical) unless the
    // reader honors the flag. Red-before flips to Critical here.
    await deliver(endpoint, 5);
    expect(batteryAlert(endpoint)).toBe(SmokeCoAlarm.AlarmState.Normal);
  });
});
