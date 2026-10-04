import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { OperationalState } from "@matter/main/clusters/operational-state";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #486: the power switch only knows on and off, the state sensor on the same
// device is found automatically.

const DEVICE = "dishwasher-dev";
const SWITCH = "switch.dishwasher_power";
const SENSOR = "sensor.dishwasher_operation_state";
// another enum sensor, listed first, must be skipped
const DOOR = "sensor.dishwasher_door";
const OPTIONS = [
  "inactive",
  "ready",
  "delayedstart",
  "run",
  "pause",
  "actionrequired",
  "finished",
  "error",
  "aborting",
];
const Op = OperationalState.OperationalStateEnum;

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let sensorValue: string;

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    device_id: DEVICE,
    entity_id: entityId,
    id: entityId,
    unique_id: entityId,
    platform: "home_connect",
    labels: [],
    categories: {},
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

function states(withSensor: boolean): HomeAssistantStates {
  const s: HomeAssistantStates = {
    [SWITCH]: state(SWITCH, "on", { friendly_name: "Dishwasher" }),
  };
  if (withSensor) {
    s[DOOR] = state(DOOR, "closed", {
      device_class: "enum",
      options: ["closed", "locked", "open"],
    });
    s[SENSOR] = state(SENSOR, sensorValue, {
      device_class: "enum",
      options: OPTIONS,
    });
  }
  return s;
}

function registry(withSensor: boolean): BridgeRegistry {
  const all = states(withSensor);
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Dishwasher" } },
    entities: Object.fromEntries(
      Object.keys(all).map((id) => [id, registryEntity(id)]),
    ),
    labels: [],
    states: all,
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-486-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  sensorValue = "inactive";
  env.set(BridgeDataProvider, dataProvider());
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantActions, { call() {}, fireEvent() {} } as any);
  env.set(EntityStateProvider, {
    getState: (id: string) =>
      id === SENSOR
        ? state(SENSOR, sensorValue, { device_class: "enum", options: OPTIONS })
        : undefined,
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

async function mount(withSensor: boolean) {
  const endpoint = await LegacyEndpoint.create(registry(withSensor), SWITCH, {
    entityId: SWITCH,
    matterDeviceType: "dishwasher",
  });
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `n486-${counter++}`,
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

async function sensor(endpoint: LegacyEndpoint, value: string) {
  sensorValue = value;
  await endpoint.updateStates(states(true));
  await delay(150);
}

function opState(endpoint: LegacyEndpoint): number {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  return Number((endpoint.state as any).operationalState.operationalState);
}

describe("#486 dishwasher mapped on its power switch", () => {
  it("reads the state from the operation state sensor", async () => {
    const endpoint = await mount(true);

    // switch on, machine idle
    expect(opState(endpoint)).toBe(Op.Stopped);

    await sensor(endpoint, "run");
    expect(opState(endpoint)).toBe(Op.Running);

    await sensor(endpoint, "pause");
    expect(opState(endpoint)).toBe(Op.Paused);

    await sensor(endpoint, "error");
    expect(opState(endpoint)).toBe(Op.Error);

    await sensor(endpoint, "finished");
    expect(opState(endpoint)).toBe(Op.Stopped);
  });

  it("still follows the switch when the device has no such sensor", async () => {
    const endpoint = await mount(false);

    expect(opState(endpoint)).toBe(Op.Running);
  });
});
