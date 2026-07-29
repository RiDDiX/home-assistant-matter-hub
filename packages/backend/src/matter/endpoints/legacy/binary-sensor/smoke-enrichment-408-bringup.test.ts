import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BinarySensorDeviceClass,
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

// #408: the smoke/CO alarm only ever wrote smokeState/coState, so batteryAlert,
// hardwareFaultAlert and expressedState sat at their matter.js defaults forever.
// The enrichment derives batteryAlert from the same battery source the
// PowerSource already uses, reads hardwareFaultAlert from a same-device problem
// sensor, and folds both into expressedState by priority.

const DEVICE = "dev1";
const SMOKE = "binary_sensor.smoke_alarm";
const BATTERY = "sensor.smoke_battery";
const FAULT = "binary_sensor.smoke_problem";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let batteryPercent: number | null;
let faultOn: boolean;

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

function registry(opts: {
  smoke: string;
  battery?: boolean;
  problem?: boolean;
}): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [SMOKE]: state(SMOKE, opts.smoke, {
      device_class: BinarySensorDeviceClass.Smoke,
    }),
  };
  if (opts.battery) {
    states[BATTERY] = state(BATTERY, "50", {
      device_class: "battery",
      unit_of_measurement: "%",
    });
  }
  if (opts.problem) {
    states[FAULT] = state(FAULT, "off", {
      device_class: BinarySensorDeviceClass.Problem,
    });
  }
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
  dir = mkdtempSync(join(tmpdir(), "hamh-smoke408-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  batteryPercent = null;
  faultOn = false;
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: (id: string) =>
      id === FAULT ? state(FAULT, faultOn ? "on" : "off") : undefined,
    getNumericState: () => null,
    getBatteryPercent: (id: string) => (id === BATTERY ? batteryPercent : null),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  // Close from afterEach so a failing assertion still tears the server down.
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function create(reg: BridgeRegistry): Promise<LegacyEndpoint> {
  const endpoint = await LegacyEndpoint.create(reg, SMOKE);
  expect(endpoint).toBeDefined();
  return endpoint!;
}

async function mount(endpoint: LegacyEndpoint) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `smoke408-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint);
  await delay(50);
}

async function deliver(
  endpoint: LegacyEndpoint,
  opts: { smoke: string; battery?: string; fault?: string },
) {
  const states: HomeAssistantStates = {
    [SMOKE]: state(SMOKE, opts.smoke, {
      device_class: BinarySensorDeviceClass.Smoke,
    }),
  };
  if (opts.battery != null) {
    states[BATTERY] = state(BATTERY, opts.battery, { device_class: "battery" });
  }
  if (opts.fault != null) {
    states[FAULT] = state(FAULT, opts.fault, {
      device_class: BinarySensorDeviceClass.Problem,
    });
  }
  await endpoint.updateStates(states);
  await delay(200);
}

function alarm(endpoint: LegacyEndpoint): {
  smokeState: SmokeCoAlarm.AlarmState;
  batteryAlert: SmokeCoAlarm.AlarmState;
  hardwareFaultAlert: boolean;
  expressedState: SmokeCoAlarm.ExpressedState;
} {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state off endpoint
  return (endpoint.state as any).smokeCoAlarm;
}

describe("smoke/CO alarm enrichment (#408)", () => {
  it("maps battery percent to batteryAlert severity", async () => {
    batteryPercent = 5;
    const endpoint = await create(registry({ smoke: "off", battery: true }));
    await mount(endpoint);
    expect(alarm(endpoint).batteryAlert).toBe(SmokeCoAlarm.AlarmState.Critical);

    batteryPercent = 15;
    await deliver(endpoint, { smoke: "off", battery: "15" });
    expect(alarm(endpoint).batteryAlert).toBe(SmokeCoAlarm.AlarmState.Warning);

    batteryPercent = 80;
    await deliver(endpoint, { smoke: "off", battery: "80" });
    expect(alarm(endpoint).batteryAlert).toBe(SmokeCoAlarm.AlarmState.Normal);
  });

  it("reflects a same-device problem sensor in hardwareFaultAlert and expressedState", async () => {
    faultOn = false;
    const endpoint = await create(registry({ smoke: "off", problem: true }));
    await mount(endpoint);
    expect(alarm(endpoint).hardwareFaultAlert).toBe(false);

    faultOn = true;
    await deliver(endpoint, { smoke: "off", fault: "on" });
    const s = alarm(endpoint);
    expect(s.hardwareFaultAlert).toBe(true);
    expect(s.expressedState).toBe(SmokeCoAlarm.ExpressedState.HardwareFault);
  });

  it("prioritizes an active smoke alarm over a battery warning", async () => {
    batteryPercent = 15;
    const endpoint = await create(registry({ smoke: "on", battery: true }));
    await mount(endpoint);
    const s = alarm(endpoint);
    expect(s.smokeState).toBe(SmokeCoAlarm.AlarmState.Warning);
    expect(s.batteryAlert).toBe(SmokeCoAlarm.AlarmState.Warning);
    expect(s.expressedState).toBe(SmokeCoAlarm.ExpressedState.SmokeAlarm);
  });

  it("keeps the problem sensor as its own contact sensor while feeding the alarm", async () => {
    // Reading the problem sensor into hardwareFaultAlert must NOT swallow its
    // standalone endpoint. Absorbing it removes a previously-exposed
    // ContactSensor and forces controllers to re-import (names/rooms lost).
    const reg = registry({ smoke: "off", problem: true });
    const smoke = await create(reg);

    const fault = await LegacyEndpoint.create(reg, FAULT);
    expect(fault).toBeDefined();
    // Matter 1.3 ContactSensor device type id (0x0015).
    // biome-ignore lint/suspicious/noExplicitAny: read the device type off the endpoint
    expect((fault as any).type.deviceType).toBe(0x15);

    faultOn = true;
    await mount(smoke);
    await deliver(smoke, { smoke: "off", fault: "on" });
    expect(alarm(smoke).hardwareFaultAlert).toBe(true);
  });

  it("leaves enrichment at defaults with no sibling sensors", async () => {
    const endpoint = await create(registry({ smoke: "off" }));
    await mount(endpoint);
    const s = alarm(endpoint);
    expect(s.smokeState).toBe(SmokeCoAlarm.AlarmState.Normal);
    expect(s.batteryAlert).toBe(SmokeCoAlarm.AlarmState.Normal);
    expect(s.hardwareFaultAlert).toBe(false);
    expect(s.expressedState).toBe(SmokeCoAlarm.ExpressedState.Normal);
  });
});
