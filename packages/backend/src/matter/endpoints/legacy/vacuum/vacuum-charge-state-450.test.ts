import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { PowerSource, RvcOperationalState } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import type { HomeAssistantRegistry } from "../../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";
import { mapVacuumOperationalState } from "./behaviors/vacuum-rvc-operational-state-server.js";

// #450: a vacuum without a resolvable battery percent reported IsCharging
// forever while docked, and free-text statuses like "Fully charged" matched
// the "charg" substring. Unknown battery must read as unknown, not charging.

const { OperationalState } = RvcOperationalState;

const DEVICE = "vac-dev";
const VACUUM = "vacuum.robot";

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

function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: {},
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

function vacuumState(
  attributes: Record<string, unknown>,
): HomeAssistantEntityState {
  return {
    entity_id: VACUUM,
    state: "docked",
    attributes: { supported_features: 15, ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function registry(attributes: Record<string, unknown>): BridgeRegistry {
  const states = { [VACUUM]: vacuumState(attributes) };
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Robot" } },
    entities: { [VACUUM]: registryEntity(VACUUM) },
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-450-"));
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

async function mount(reg: BridgeRegistry): Promise<LegacyEndpoint> {
  // a second mount in one test must not leak the previous node
  await server?.close().catch(() => {});
  const endpoint = await LegacyEndpoint.create(reg, VACUUM, undefined);
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `450-node-${counter++}`,
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

function chargeState(endpoint: LegacyEndpoint): number | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  return (endpoint.state as any).powerSource?.batChargeState;
}

describe("power source with unknown battery (#450)", () => {
  it("reports Unknown instead of eternal IsCharging while docked", async () => {
    const endpoint = await mount(registry({ status: "Fully charged" }));
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).powerSource?.batPercentRemaining).toBeNull();
    expect(chargeState(endpoint)).toBe(PowerSource.BatChargeState.Unknown);
  });

  it("keeps IsCharging and IsAtFullCharge when the percent is known", async () => {
    const endpoint = await mount(registry({ battery_level: 75 }));
    expect(chargeState(endpoint)).toBe(PowerSource.BatChargeState.IsCharging);

    const full = await mount(registry({ battery_level: 100 }));
    expect(chargeState(full)).toBe(PowerSource.BatChargeState.IsAtFullCharge);
  });
});

describe("operational state with unknown battery (#450)", () => {
  it("Fully charged status is not charging", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: { status: "Fully charged" },
      }),
    ).toBe(OperationalState.Docked);
  });

  it("not charging status is not charging", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: { status: "Not charging" },
      }),
    ).toBe(OperationalState.Docked);
  });

  it("idle with a completed charge status is Stopped", () => {
    expect(
      mapVacuumOperationalState({
        state: "idle",
        attributes: { status: "Charge complete" },
      }),
    ).toBe(OperationalState.Stopped);
  });

  it("a stale charging icon does not beat a terminal status", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: {
          status: "Fully charged",
          battery_icon: "mdi:battery-charging-100",
        },
      }),
    ).toBe(OperationalState.Docked);
  });

  it("underscore and hyphen not-charging variants are not charging", () => {
    for (const status of ["not_charging", "not-charging"]) {
      expect(
        mapVacuumOperationalState({
          state: "docked",
          attributes: { status },
        }),
      ).toBe(OperationalState.Docked);
    }
  });

  it("a real charging status still reads Charging", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: { status: "charging" },
      }),
    ).toBe(OperationalState.Charging);
  });
});

// A docked vacuum reported charging whenever it sat below full. When the device
// has its own charging signal, that entity is mapped automatically now (#450).

function chargingRegistry(
  chargingEntityId: string,
  chargingState: string,
  attributes: Record<string, unknown>,
): { reg: BridgeRegistry; states: Record<string, HomeAssistantEntityState> } {
  const chargingAttributes = chargingEntityId.startsWith("binary_sensor.")
    ? { device_class: "battery_charging" }
    : {};
  const states: Record<string, HomeAssistantEntityState> = {
    [VACUUM]: vacuumState(attributes),
    [chargingEntityId]: {
      entity_id: chargingEntityId,
      state: chargingState,
      attributes: chargingAttributes,
      context: { id: "ctx" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
    },
  };
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Robot" } },
    entities: {
      [VACUUM]: registryEntity(VACUUM),
      [chargingEntityId]: registryEntity(chargingEntityId),
    },
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  return { reg: new BridgeRegistry(haRegistry, dataProvider()), states };
}

async function mountWithCharging(
  chargingEntityId: string,
  chargingState: string,
  attributes: Record<string, unknown>,
): Promise<LegacyEndpoint> {
  const { reg, states } = chargingRegistry(
    chargingEntityId,
    chargingState,
    attributes,
  );
  env.set(EntityStateProvider, {
    getState: (id: string) => states[id],
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  return mount(reg);
}

describe("charging entity auto assignment (#450)", () => {
  it("takes a battery_charging binary sensor over the docked guess", async () => {
    const endpoint = await mountWithCharging(
      "binary_sensor.robot_charging",
      "off",
      { battery_level: 96 },
    );
    expect(endpoint.mappedEntityIds).toContain("binary_sensor.robot_charging");
    expect(chargeState(endpoint)).toBe(
      PowerSource.BatChargeState.IsNotCharging,
    );
  });

  it("reports charging when that sensor says so", async () => {
    // 100% so the docked guess would say IsAtFullCharge, only the sensor
    // can produce IsCharging here
    const endpoint = await mountWithCharging(
      "binary_sensor.robot_charging",
      "on",
      { battery_level: 100 },
    );
    expect(endpoint.mappedEntityIds).toContain("binary_sensor.robot_charging");
    expect(chargeState(endpoint)).toBe(PowerSource.BatChargeState.IsCharging);
  });

  it("keeps IsAtFullCharge when a full robot sits on the dock", async () => {
    const endpoint = await mountWithCharging(
      "binary_sensor.robot_charging",
      "off",
      { battery_level: 100 },
    );
    expect(chargeState(endpoint)).toBe(
      PowerSource.BatChargeState.IsAtFullCharge,
    );
  });

  it("takes a charging_state sensor as well", async () => {
    const endpoint = await mountWithCharging(
      "sensor.robot_charging_state",
      "not_charging",
      { battery_level: 96 },
    );
    expect(endpoint.mappedEntityIds).toContain("sensor.robot_charging_state");
    expect(chargeState(endpoint)).toBe(
      PowerSource.BatChargeState.IsNotCharging,
    );
  });

  it("keeps the docked guess when the device has no charging entity", async () => {
    const endpoint = await mount(registry({ battery_level: 96 }));
    expect(endpoint.mappedEntityIds).toEqual([]);
    expect(chargeState(endpoint)).toBe(PowerSource.BatChargeState.IsCharging);
  });
});
