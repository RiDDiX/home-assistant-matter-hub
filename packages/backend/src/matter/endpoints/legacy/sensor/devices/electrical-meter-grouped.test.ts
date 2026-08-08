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

// A power sensor with a mapping of voltage/current/energy companions folds all
// four measurements onto one ElectricalMeter (0x0514) endpoint. The primary
// power drives activePower; the mapped companions are read through the
// EntityStateProvider, so they must be seeded before mount (same as the ESS).

const ELECTRICAL_METER = 0x0514; // 1300

const GRID_POWER = "sensor.grid_power";
const GRID_VOLTAGE = "sensor.grid_voltage";
const GRID_CURRENT = "sensor.grid_current";
const GRID_ENERGY = "sensor.grid_energy";

// 1500 W -> 1_500_000 mW on the wire.
const POWER_WATTS = "1500";
const EXPECTED_ACTIVE_POWER = 1_500_000;
// 230 V -> 230_000 mV.
const VOLTAGE_V = 230;
const EXPECTED_VOLTAGE = 230_000;
// 6.5 A -> 6_500 mA.
const CURRENT_A = 6.5;
const EXPECTED_CURRENT = 6_500;
// 12.5 kWh -> 12_500_000 mWh.
const ENERGY_KWH = 12.5;
const EXPECTED_ENERGY = 12_500_000;

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-electrical-meter-grouped-"));
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
  // The power/energy servers read the mapped companions through the provider:
  // volts for voltage, amps for activeCurrent, kWh for cumulativeEnergyImported.
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: (id: string) => {
      if (id === GRID_VOLTAGE) return VOLTAGE_V;
      if (id === GRID_CURRENT) return CURRENT_A;
      if (id === GRID_ENERGY) return ENERGY_KWH;
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

function sensorEntity(
  entityId: string,
  value: string,
  deviceClass: string,
  unit: string,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: entityId,
    state: value,
    attributes: {
      friendly_name: entityId,
      device_class: deviceClass,
      unit_of_measurement: unit,
    },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: state as any };
}

interface Snapshot {
  deviceTypes: number[];
  activePower: number;
  voltage: number;
  activeCurrent: number;
  cumulativeEnergy: number;
}

// Mount the endpoint under a real ServerNode (no AggregateError proves the
// mandatory clusters are seeded) and read back the wire values.
async function bringUp(
  entity: HomeAssistantEntityInformation,
  mapping?: EntityMappingConfig,
): Promise<Snapshot> {
  const type = createLegacyEndpointType(entity, mapping);
  if (!type) {
    throw new Error("no endpoint type");
  }
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `electrical-meter-grouped-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "electrical-meter" });
  await aggregator.add(endpoint);

  const snapshot: Snapshot = {
    deviceTypes: [],
    activePower: Number.NaN,
    voltage: Number.NaN,
    activeCurrent: Number.NaN,
    cumulativeEnergy: Number.NaN,
  };
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const a = agent as any;
    const dtl = a.descriptor.state.deviceTypeList as Array<{
      deviceType: number;
    }>;
    snapshot.deviceTypes = dtl.map((d) => Number(d.deviceType));
    // int64 attributes may come back as bigint, so normalize through Number.
    snapshot.activePower = Number(
      a.electricalPowerMeasurement?.state.activePower,
    );
    snapshot.voltage = Number(a.electricalPowerMeasurement?.state.voltage);
    snapshot.activeCurrent = Number(
      a.electricalPowerMeasurement?.state.activeCurrent,
    );
    snapshot.cumulativeEnergy = Number(
      a.electricalEnergyMeasurement?.state.cumulativeEnergyImported?.energy,
    );
  });
  return snapshot;
}

describe("electrical meter grouped measurements", () => {
  it("folds power/voltage/current/energy onto one ElectricalMeter endpoint", async () => {
    const snapshot = await bringUp(
      sensorEntity(GRID_POWER, POWER_WATTS, "power", "W"),
      {
        entityId: GRID_POWER,
        voltageEntity: GRID_VOLTAGE,
        currentEntity: GRID_CURRENT,
        energyEntity: GRID_ENERGY,
      },
    );

    expect(snapshot.deviceTypes).toContain(ELECTRICAL_METER);
    // Primary power sensor drives activePower.
    expect(snapshot.activePower).toBe(EXPECTED_ACTIVE_POWER);
    // Mapped companions folded onto the same power cluster.
    expect(snapshot.voltage).toBe(EXPECTED_VOLTAGE);
    expect(snapshot.activeCurrent).toBe(EXPECTED_CURRENT);
    // Mapped energy companion on the energy cluster.
    expect(snapshot.cumulativeEnergy).toBe(EXPECTED_ENERGY);
  });
});
