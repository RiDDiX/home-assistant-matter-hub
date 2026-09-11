import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HomeAssistantEntityState,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { EntityMappingSync } from "../../../services/bridges/entity-mapping-sync.js";
import { EntityStateProvider } from "../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../services/home-assistant/home-assistant-config.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../aggregator-endpoint.js";
import { updateEntityState } from "../update-entity-state.js";
import { ComposedAirPurifierEndpoint } from "./composed-air-purifier-endpoint.js";

vi.mock("../update-entity-state.js", () => ({
  updateEntityState: vi.fn(async () => {}),
}));

// #461: a Mi Air Purifier burned 26% CPU because the composed endpoint was
// rebuilt many times per second. Two causes: the filter life sensor (17%,
// no device_class) was resolved as a battery, and the composed endpoint never
// listed its battery in mappedEntityIds, so the fingerprint said "built
// without battery" and the auto-map retry fired again on every sensor update.

const FAN = "fan.purifier";
const TEMPERATURE = "sensor.purifier_temperature";
const FILTER_LIFE = "sensor.purifier_filter_life_remaining";
const BATTERY = "sensor.purifier_battery";

function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes: { friendly_name: entityId, ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function haRegistry(withBattery: boolean): HomeAssistantRegistry {
  const entities: Record<string, unknown> = {
    [FAN]: { entity_id: FAN, device_id: "dev1" },
    [TEMPERATURE]: { entity_id: TEMPERATURE, device_id: "dev1" },
    [FILTER_LIFE]: { entity_id: FILTER_LIFE, device_id: "dev1" },
  };
  const states: HomeAssistantStates = {
    [FAN]: state(FAN, "off", { supported_features: 56 }),
    [TEMPERATURE]: state(TEMPERATURE, "21.5", {
      device_class: "temperature",
      unit_of_measurement: "°C",
    }),
    [FILTER_LIFE]: state(FILTER_LIFE, "17", {
      state_class: "measurement",
      filter_type: "regular",
      unit_of_measurement: "%",
    }),
  };
  if (withBattery) {
    entities[BATTERY] = { entity_id: BATTERY, device_id: "dev1" };
    states[BATTERY] = state(BATTERY, "80", {
      device_class: "battery",
      unit_of_measurement: "%",
    });
  }
  return {
    entities,
    states,
    devices: { dev1: { id: "dev1", name: "Mi Air Purifier" } },
    labels: [],
    areas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  } as any;
}

function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: "*" }],
      exclude: [],
      includeMode: "any",
    },
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

function bridgeRegistry(withBattery = false): BridgeRegistry {
  return new BridgeRegistry(haRegistry(withBattery), dataProvider());
}

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-purifier461-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantActions, {
    call() {},
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
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(endpoint: ComposedAirPurifierEndpoint) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `purifier461-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mountedPurifier() {
  const registry = bridgeRegistry(true);
  const endpoint = await ComposedAirPurifierEndpoint.create({
    registry,
    primaryEntityId: FAN,
    temperatureEntityId: TEMPERATURE,
    batteryEntityId: BATTERY,
    mapping: { entityId: FAN, batteryEntity: BATTERY },
  });
  expect(endpoint).toBeDefined();
  await mount(endpoint!);
  vi.mocked(updateEntityState).mockClear();
  return endpoint!;
}

describe("#461 air purifier rebuild loop", () => {
  it("does not resolve the filter life sensor as a battery", () => {
    expect(bridgeRegistry().findBatteryEntityForDevice("dev1")).toBeUndefined();
  });

  it("still resolves a real battery sensor on the same device", () => {
    expect(bridgeRegistry(true).findBatteryEntityForDevice("dev1")).toBe(
      BATTERY,
    );
  });

  it("maps the battery entity, so the fingerprint counts it as built", async () => {
    const registry = bridgeRegistry(true);
    const mapping = { entityId: FAN, batteryEntity: BATTERY };
    const endpoint = await ComposedAirPurifierEndpoint.create({
      registry,
      primaryEntityId: FAN,
      temperatureEntityId: TEMPERATURE,
      batteryEntityId: BATTERY,
      mapping,
    });
    expect(endpoint).toBeDefined();
    expect(endpoint!.mappedEntityIds).toContain(BATTERY);

    const sync = new EntityMappingSync(
      registry,
      () => mapping,
      Logger.get("test"),
    );
    // battery-less fingerprint here means the retry rebuilds forever
    expect(
      sync.fingerprintAsBuilt(mapping, FAN, endpoint!.mappedEntityIds),
    ).toBe(sync.computeFingerprint(mapping, FAN));
  });

  // a rebuild goes through close(), the queued flush used to land on the closed endpoint
  it("flushes a queued update while the endpoint is open", async () => {
    const endpoint = await mountedPurifier();
    await endpoint.updateStates({
      [FAN]: state(FAN, "on", { supported_features: 56, percentage: 40 }),
    });
    await delay(200);
    expect(updateEntityState).toHaveBeenCalled();
  });

  it("drops a queued update when the endpoint is closed", async () => {
    const endpoint = await mountedPurifier();
    await endpoint.updateStates({
      [FAN]: state(FAN, "on", { supported_features: 56, percentage: 40 }),
    });
    await endpoint.close();
    await delay(200);
    expect(updateEntityState).not.toHaveBeenCalled();
  });
});
