import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
  MatterDeviceType,
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

// Washers and dryers on their power switch, state from the integration's
// enum sensor. Option lists as in HA core (home_connect, smartthings, miele,
// lg_thinq).

const DEVICE = "laundry-dev";
const SWITCH = "switch.laundry_power";
const SENSOR = "sensor.laundry_state";
const Op = OperationalState.OperationalStateEnum;

const integrations: Record<string, string[]> = {
  home_connect: [
    "inactive",
    "ready",
    "delayedstart",
    "run",
    "pause",
    "actionrequired",
    "finished",
    "error",
    "aborting",
  ],
  smartthings: ["pause", "run", "stop"],
  miele: [
    "autocleaning",
    "failure",
    "idle",
    "in_use",
    "not_connected",
    "off",
    "on",
    "pause",
    "program_ended",
    "program_interrupted",
    "programmed",
    "reserved",
    "rinse_hold",
    "service",
    "supercooling",
    "supercooling_superfreezing",
    "superfreezing",
    "superheating",
    "waiting_to_start",
  ],
  // LG sends the list per model, this is a plausible washer subset
  lg_thinq: [
    "power_off",
    "initial",
    "detecting",
    "running",
    "rinsing",
    "spinning",
    "pause",
    "end",
    "error",
    "power_fail",
  ],
};

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let options: string[];
let sensorValue: string;

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    device_id: DEVICE,
    entity_id: entityId,
    id: entityId,
    unique_id: entityId,
    platform: "test",
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

function sensorState() {
  return state(SENSOR, sensorValue, { device_class: "enum", options });
}

function states(): HomeAssistantStates {
  return {
    [SWITCH]: state(SWITCH, "on", { friendly_name: "Laundry" }),
    [SENSOR]: sensorState(),
  };
}

function registry(): BridgeRegistry {
  const all = states();
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Laundry" } },
    entities: Object.fromEntries(
      Object.keys(all).map((id) => [id, registryEntity(id)]),
    ),
    labels: [],
    states: all,
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-laundry-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantActions, { call() {}, fireEvent() {} } as any);
  env.set(EntityStateProvider, {
    getState: (id: string) => (id === SENSOR ? sensorState() : undefined),
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

async function mount(type: MatterDeviceType) {
  const endpoint = await LegacyEndpoint.create(registry(), SWITCH, {
    entityId: SWITCH,
    matterDeviceType: type,
  });
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `laundry-${counter++}`,
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
  await endpoint.updateStates(states());
  await delay(150);
}

// biome-ignore lint/suspicious/noExplicitAny: read cluster state
const clusters = (endpoint: LegacyEndpoint) => endpoint.state as any;
const opState = (endpoint: LegacyEndpoint) =>
  Number(clusters(endpoint).operationalState.operationalState);

function completions(endpoint: LegacyEndpoint): number[] {
  const seen: number[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: behavior events
  (endpoint.events as any).operationalState.operationCompletion.on(
    (payload: { completionErrorCode: number }) =>
      seen.push(payload.completionErrorCode),
  );
  return seen;
}

describe.each([
  ["laundry_washer", 0x73],
  ["laundry_dryer", 0x7c],
] as const)("%s", (type, deviceTypeId) => {
  it("advertises the device type and a spec-shaped OnOff", async () => {
    options = integrations.home_connect;
    sensorValue = "ready";
    const endpoint = await mount(type);

    const types = clusters(endpoint).descriptor.deviceTypeList.map(
      (d: { deviceType: number }) => d.deviceType,
    );
    expect(types).toContain(deviceTypeId);
    expect(clusters(endpoint).onOff.featureMap.deadFrontBehavior).toBe(true);
    expect(clusters(endpoint).homeAssistantEntity.mapping).toMatchObject({
      operationalStateEntity: SENSOR,
    });
  });

  it("reports a finished cycle as OperationCompletion", async () => {
    options = integrations.home_connect;
    sensorValue = "ready";
    const endpoint = await mount(type);
    const seen = completions(endpoint);

    await sensor(endpoint, "run");
    await sensor(endpoint, "finished");
    await sensor(endpoint, "run");
    await sensor(endpoint, "error");

    expect(seen).toEqual([
      OperationalState.ErrorState.NoError,
      OperationalState.ErrorState.UnableToCompleteOperation,
    ]);
  });

  it("keeps the cycle going while the sensor is unavailable", async () => {
    options = integrations.home_connect;
    sensorValue = "ready";
    const endpoint = await mount(type);
    const seen = completions(endpoint);

    await sensor(endpoint, "run");
    await sensor(endpoint, "unavailable");
    expect(opState(endpoint)).toBe(Op.Running);
    await sensor(endpoint, "run");
    await sensor(endpoint, "finished");

    expect(seen).toEqual([OperationalState.ErrorState.NoError]);
  });

  it("keeps the cycle going on a sensor state it doesn't know", async () => {
    options = integrations.miele;
    sensorValue = "on";
    const endpoint = await mount(type);
    const seen = completions(endpoint);

    await sensor(endpoint, "in_use");
    await sensor(endpoint, "not_connected");
    expect(opState(endpoint)).toBe(Op.Running);
    await sensor(endpoint, "program_ended");

    expect(seen).toEqual([OperationalState.ErrorState.NoError]);
  });
});

describe.each([
  ["home_connect", "ready", "run", "pause", "finished", "error"],
  ["smartthings", "stop", "run", "pause", "stop", undefined],
  ["miele", "on", "in_use", "pause", "program_ended", "failure"],
  ["lg_thinq", "initial", "running", "pause", "end", "power_fail"],
] as const)("%s state sensor", (integration, idle, run, pause, done, error) => {
  it("is found and drives the washer", async () => {
    options = integrations[integration];
    sensorValue = idle;
    const endpoint = await mount("laundry_washer");

    expect(opState(endpoint)).toBe(Op.Stopped);
    await sensor(endpoint, run);
    expect(opState(endpoint)).toBe(Op.Running);
    await sensor(endpoint, pause);
    expect(opState(endpoint)).toBe(Op.Paused);
    await sensor(endpoint, done);
    expect(opState(endpoint)).toBe(Op.Stopped);
    if (error) {
      await sensor(endpoint, error);
      expect(opState(endpoint)).toBe(Op.Error);
    }
  });
});

describe("LG in-cycle states", () => {
  it("counts rinsing and spinning as running", async () => {
    options = integrations.lg_thinq;
    sensorValue = "power_off";
    const endpoint = await mount("laundry_washer");

    for (const value of ["detecting", "rinsing", "spinning"]) {
      await sensor(endpoint, value);
      expect(opState(endpoint)).toBe(Op.Running);
    }
  });
});
