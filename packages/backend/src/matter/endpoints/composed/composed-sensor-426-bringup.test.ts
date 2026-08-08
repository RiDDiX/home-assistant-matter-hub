import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HomeAssistantEntityState,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../services/home-assistant/home-assistant-config.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../services/home-assistant/home-assistant-registry.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../aggregator-endpoint.js";
import { LegacyEndpoint } from "../legacy/legacy-endpoint.js";
import type { ComposedSensorEndpoint } from "./composed-sensor-endpoint.js";

// #426: same class of bug as #408, in the auto-composed temperature sensor
// path this time. buildEntityPayload in composed-sensor-endpoint.ts read the
// filtered registry maps, so a humidity or pressure sensor sitting outside
// the bridge filter silently dropped its sub-endpoint, while the battery
// (read through EntityStateProvider, not buildEntityPayload) kept working.
// The fix reads the full registry for the sub-entities, mirroring #408.

const TEMPERATURE = "sensor.x_temperature";
const HUMIDITY = "sensor.x_humidity";
const PRESSURE = "sensor.x_pressure";
const BATTERY = "sensor.x_battery";

function state(
  entityId: string,
  value: string,
  deviceClass: string,
  unit?: string,
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes: {
      friendly_name: entityId,
      device_class: deviceClass,
      unit_of_measurement: unit,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

// one HA device with a temperature sensor plus humidity/pressure/battery
// siblings that all sit outside the bridge filter
function haRegistry(): HomeAssistantRegistry {
  const entities = {
    [TEMPERATURE]: { entity_id: TEMPERATURE, device_id: "dev1" },
    [HUMIDITY]: { entity_id: HUMIDITY, device_id: "dev1" },
    [PRESSURE]: { entity_id: PRESSURE, device_id: "dev1" },
    [BATTERY]: { entity_id: BATTERY, device_id: "dev1" },
  };
  const states: HomeAssistantStates = {
    [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
    [HUMIDITY]: state(HUMIDITY, "55", "humidity", "%"),
    [PRESSURE]: state(PRESSURE, "1013", "pressure", "hPa"),
    [BATTERY]: state(BATTERY, "80", "battery", "%"),
  };
  return {
    entities,
    states,
    devices: { dev1: { id: "dev1", name: "Sensor Hub" } },
    labels: [],
    areas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  } as any;
}

function dataProvider(): BridgeDataProvider {
  // only the temperature entity matches the bridge filter; humidity, pressure
  // and battery live on the same HA device but stay outside it
  const include = [
    { type: HomeAssistantMatcherType.Pattern, value: "*_temperature" },
  ];
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: { include, exclude: [], includeMode: "any" },
    featureFlags: { autoComposedDevices: true },
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

function bridgeRegistry(): BridgeRegistry {
  return new BridgeRegistry(haRegistry(), dataProvider());
}

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let batteryPercent = 80;

beforeEach(() => {
  batteryPercent = 80;
  dir = mkdtempSync(join(tmpdir(), "hamh-426-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => undefined,
    getBatteryPercent: (id: string) => (id === BATTERY ? batteryPercent : null),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function create(): Promise<ComposedSensorEndpoint> {
  const registry = bridgeRegistry();
  // no explicit mapping: this drives the real auto-finders in
  // LegacyEndpoint.create (humidity/pressure/battery auto-assignment) and
  // then the ComposedSensorEndpoint dispatch, exactly as the bridge does.
  const endpoint = await LegacyEndpoint.create(registry, TEMPERATURE);
  return endpoint as unknown as ComposedSensorEndpoint;
}

async function mount(endpoint: ComposedSensorEndpoint) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `composed426-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("composed sensor endpoint with out-of-filter humidity and pressure subs (#426)", () => {
  it("composes humidity and pressure sub-endpoints that do not match the bridge filter", async () => {
    const endpoint = await create();

    expect(endpoint).toBeDefined();
    // temperature sub + humidity sub + pressure sub
    expect([...endpoint.parts].length).toBe(3);

    expect(endpoint.mappedEntityIds).toContain(HUMIDITY);
    expect(endpoint.mappedEntityIds).toContain(PRESSURE);

    await mount(endpoint);

    const subEntityIds = [...endpoint.parts].map(
      (p) => p.stateOf(HomeAssistantEntityBehavior).entity.entity_id,
    );
    expect(subEntityIds).toContain(HUMIDITY);
    expect(subEntityIds).toContain(PRESSURE);
  });

  it("keeps the parent battery working alongside the out-of-filter subs", async () => {
    const endpoint = await create();
    await mount(endpoint);
    await delay(50);

    // batPercentRemaining is half-percent units, so 80% becomes 160
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    const power = (endpoint.state as any).powerSource;
    expect(power.batPercentRemaining).toBe(160);
  });

  it("keeps live updates flowing to an out-of-filter humidity sub-endpoint", async () => {
    const endpoint = await create();
    await mount(endpoint);

    const states: HomeAssistantStates = {
      [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
      [HUMIDITY]: state(HUMIDITY, "70", "humidity", "%"),
      [PRESSURE]: state(PRESSURE, "1013", "pressure", "hPa"),
      [BATTERY]: state(BATTERY, "80", "battery", "%"),
    };
    await endpoint.updateStates(states);
    await delay(200); // scheduleUpdate debounces 50ms then flushes async

    const sub = [...endpoint.parts].find(
      (p) =>
        p.stateOf(HomeAssistantEntityBehavior).entity.entity_id === HUMIDITY,
    );
    expect(sub).toBeDefined();
    expect(sub!.stateOf(HomeAssistantEntityBehavior).entity.state.state).toBe(
      "70",
    );
  });
});
