import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../../create-legacy-endpoint-type.js";

// A home battery (device_class battery) with a mapped power/energy sensor is a
// BatteryStorage ESS (deviceType 0x0018 = 24) carrying the electrical measurement
// clusters. The #419 lesson: those mandatory attributes must be seeded or mounting
// throws AggregateError. This brings the real endpoint online and checks the wire
// values. A plain percent battery must stay the lighter BatterySensorType with no
// electrical clusters.

const BATTERY_DEVICE_TYPE = 24;

const BATTERY = "sensor.home_battery";
const BATTERY_POWER = "sensor.home_battery_power";
const BATTERY_ENERGY = "sensor.home_battery_energy";

// Charging at 500 W, so the HA sensor reads -500 (positive means discharge).
// Matter counts imported power as positive, so the wire value is +500000 mW.
const POWER_WATTS = -500;
const EXPECTED_ACTIVE_POWER = 500_000;
// Lifetime throughput. 12.5 kWh -> 12500000 mWh on the wire.
const ENERGY_KWH = 12.5;
const EXPECTED_ENERGY = 12_500_000;
// 80 % battery. batPercentRemaining is half-percent units, so 160.
const BATTERY_STATE = "80";
const EXPECTED_BAT_PERCENT = 160;

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-ess-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
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
    } as any),
  );
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  // The ESS reads the mapped companion entities through the provider: watts for
  // activePower, kWh for cumulativeEnergyImported. Battery percent comes from the
  // sensor's own state, not the provider.
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: (id: string) => {
      if (id === BATTERY_POWER) return POWER_WATTS;
      if (id === BATTERY_ENERGY) return ENERGY_KWH;
      return null;
    },
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function batteryEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: BATTERY,
    state: BATTERY_STATE,
    attributes: {
      friendly_name: "Home Battery",
      device_class: "battery",
      unit_of_measurement: "%",
    },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: BATTERY, state: state as any };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(mapping?: EntityMappingConfig): Promise<Endpoint> {
  const type = createLegacyEndpointType(batteryEntity(), mapping);
  if (!type) {
    throw new Error("no endpoint type");
  }
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `ess-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "battery" });
  await aggregator.add(endpoint);
  await delay(50);
  return endpoint;
}

function deviceTypes(endpoint: Endpoint): number[] {
  // biome-ignore lint/suspicious/noExplicitAny: read descriptor state
  const list = (endpoint.state as any).descriptor.deviceTypeList as Array<{
    deviceType: number;
  }>;
  return list.map((d) => Number(d.deviceType));
}

describe("battery storage ESS bring-up (#386)", () => {
  it("mounts the ESS with deviceType 24 and the signed electrical measurements", async () => {
    const endpoint = await mount({
      entityId: BATTERY,
      batteryPowerEntity: BATTERY_POWER,
      batteryEnergyEntity: BATTERY_ENERGY,
    });

    expect(deviceTypes(endpoint)).toContain(BATTERY_DEVICE_TYPE);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const state = endpoint.state as any;
    expect(state.powerSource.batPercentRemaining).toBe(EXPECTED_BAT_PERCENT);
    // Charging imports power, so the wire value is positive mW.
    expect(state.electricalPowerMeasurement.activePower).toBe(
      EXPECTED_ACTIVE_POWER,
    );
    expect(
      state.electricalEnergyMeasurement.cumulativeEnergyImported.energy,
    ).toBe(EXPECTED_ENERGY);
  });

  it("mounts only the power cluster when just batteryPowerEntity is mapped", async () => {
    const endpoint = await mount({
      entityId: BATTERY,
      batteryPowerEntity: BATTERY_POWER,
    });

    expect(deviceTypes(endpoint)).toContain(BATTERY_DEVICE_TYPE);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const state = endpoint.state as any;
    expect(state.electricalPowerMeasurement.activePower).toBe(
      EXPECTED_ACTIVE_POWER,
    );
    // No mapped energy entity, so no energy cluster advertising a fake zero.
    expect("electricalEnergyMeasurement" in state).toBe(false);
  });

  it("keeps a plain battery as BatterySensorType without electrical clusters", async () => {
    const endpoint = await mount();

    // Still a BatteryStorage device (24), same as the ESS, but the lighter one:
    // the discriminator is the missing electrical measurement clusters.
    expect(deviceTypes(endpoint)).toContain(BATTERY_DEVICE_TYPE);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const state = endpoint.state as any;
    expect(state.powerSource.batPercentRemaining).toBe(EXPECTED_BAT_PERCENT);
    expect("electricalPowerMeasurement" in state).toBe(false);
    expect("electricalEnergyMeasurement" in state).toBe(false);
  });
});
