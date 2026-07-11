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
import { UserComposedEndpoint } from "./user-composed-endpoint.js";

// #408: a user picks composed sub-entities from the full HA registry, but the
// bridge filter only lets binary_sensor.* through. The old buildEntityPayload
// read the filtered maps, so the two sensors were invisible, got skipped, and
// the device dropped below 2 parts and fell back to standalone. The fix reads
// the full registry for sub-entities only.

const PRIMARY = "binary_sensor.occupancy";
const ILLUMINANCE = "sensor.illuminance";
const TEMPERATURE = "sensor.temperature";

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

// three entities on one HA device, primary + two out-of-filter sensors
function haRegistry(): HomeAssistantRegistry {
  const entities = {
    [PRIMARY]: { entity_id: PRIMARY, device_id: "dev1" },
    [ILLUMINANCE]: { entity_id: ILLUMINANCE, device_id: "dev1" },
    [TEMPERATURE]: { entity_id: TEMPERATURE, device_id: "dev1" },
  };
  const states: HomeAssistantStates = {
    [PRIMARY]: state(PRIMARY, "on", "occupancy"),
    [ILLUMINANCE]: state(ILLUMINANCE, "42", "illuminance", "lx"),
    [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
  };
  return {
    entities,
    states,
    devices: { dev1: { id: "dev1", name: "Hue Motion" } },
    labels: [],
    areas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  } as any;
}

function dataProvider(includePrimaryOnly: boolean): BridgeDataProvider {
  const include = includePrimaryOnly
    ? [{ type: HomeAssistantMatcherType.Pattern, value: "binary_sensor.*" }]
    : [];
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

function bridgeRegistry(includePrimaryOnly: boolean): BridgeRegistry {
  return new BridgeRegistry(haRegistry(), dataProvider(includePrimaryOnly));
}

const composedEntities = [
  { entityId: ILLUMINANCE, matterDeviceType: "light_sensor" as const },
  { entityId: TEMPERATURE, matterDeviceType: "temperature_sensor" as const },
];

function create(registry: BridgeRegistry) {
  return UserComposedEndpoint.create({
    registry,
    primaryEntityId: PRIMARY,
    mapping: { entityId: PRIMARY },
    composedEntities,
  });
}

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-408-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider(true));
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
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(endpoint: UserComposedEndpoint) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `composed408-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("user composed device with out-of-filter sub-entities (#408)", () => {
  it("composes sub-entities that do not match the bridge filter", async () => {
    const endpoint = await create(bridgeRegistry(true));

    expect(endpoint).toBeDefined();
    expect(endpoint!.mappedEntityIds).toContain(ILLUMINANCE);
    expect(endpoint!.mappedEntityIds).toContain(TEMPERATURE);
    // primary + two subs, so the "Cannot find" skip path was not taken
    expect([...endpoint!.parts].length).toBe(3);
  });

  it("keeps live updates flowing to an out-of-filter sub-endpoint", async () => {
    const endpoint = await create(bridgeRegistry(true));
    expect(endpoint).toBeDefined();
    await mount(endpoint!);

    const states: HomeAssistantStates = {
      [PRIMARY]: state(PRIMARY, "on", "occupancy"),
      [ILLUMINANCE]: state(ILLUMINANCE, "99", "illuminance", "lx"),
      [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
    };
    await endpoint!.updateStates(states);
    await delay(200); // scheduleUpdate debounces 50ms then flushes async

    const sub = [...endpoint!.parts].find(
      (p) =>
        p.stateOf(HomeAssistantEntityBehavior).entity.entity_id === ILLUMINANCE,
    );
    expect(sub).toBeDefined();
    expect(sub!.stateOf(HomeAssistantEntityBehavior).entity.state.state).toBe(
      "99",
    );
  });

  it("still composes when all sub-entities are inside the filter", async () => {
    const endpoint = await create(bridgeRegistry(false));

    expect(endpoint).toBeDefined();
    expect(endpoint!.mappedEntityIds).toEqual([ILLUMINANCE, TEMPERATURE]);
    expect([...endpoint!.parts].length).toBe(3);
  });
});
