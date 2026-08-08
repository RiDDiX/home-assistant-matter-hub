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

// ElectricalUtilityMeter (0x0511) is opt-in via the entity mapping. Its sole
// mandatory cluster is MeterIdentification, whose attributes are all nullable,
// so the endpoint must mount with nulls when nothing is configured (#419).

const ELECTRICAL_UTILITY_METER = 0x0511; // 1297
const ELECTRICAL_METER = 0x0514; // 1300
const ELECTRICAL_SENSOR = 0x0510; // 1296

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-utility-meter-"));
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
  cumulativeEnergy: number;
  meterType: unknown;
  pointOfDelivery: unknown;
  meterSerialNumber: unknown;
  hasMeterIdentification: boolean;
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
    id: `utility-meter-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "utility-meter" });
  await aggregator.add(endpoint);

  const snapshot: Snapshot = {
    deviceTypes: [],
    cumulativeEnergy: Number.NaN,
    meterType: "unset",
    pointOfDelivery: "unset",
    meterSerialNumber: "unset",
    hasMeterIdentification: false,
  };
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const a = agent as any;
    const dtl = a.descriptor.state.deviceTypeList as Array<{
      deviceType: number;
    }>;
    snapshot.deviceTypes = dtl.map((d) => Number(d.deviceType));
    snapshot.cumulativeEnergy = Number(
      a.electricalEnergyMeasurement?.state.cumulativeEnergyImported?.energy,
    );
    const meter = a.meterIdentification?.state;
    snapshot.hasMeterIdentification = meter != null;
    snapshot.meterType = meter?.meterType;
    snapshot.pointOfDelivery = meter?.pointOfDelivery;
    snapshot.meterSerialNumber = meter?.meterSerialNumber;
  });
  return snapshot;
}

describe("electrical utility meter bring-up (#419 seeding)", () => {
  it("mounts a kWh sensor as ElectricalUtilityMeter with null identification", async () => {
    const snapshot = await bringUp(
      sensorEntity("sensor.grid_meter_energy", "12.5", "energy", "kWh"),
      {
        entityId: "sensor.grid_meter_energy",
        matterDeviceType: "electrical_utility_meter",
      },
    );

    expect(snapshot.deviceTypes).toContain(ELECTRICAL_UTILITY_METER);
    // Measurements ride on the same endpoint, which matter.js then also
    // advertises as ElectricalSensor (PowerTopology + measurement clusters).
    expect(snapshot.deviceTypes).toContain(ELECTRICAL_SENSOR);
    expect(snapshot.deviceTypes).not.toContain(ELECTRICAL_METER);
    // All MeterIdentification attributes are nullable and must mount as null.
    expect(snapshot.hasMeterIdentification).toBe(true);
    expect(snapshot.meterType).toBeNull();
    expect(snapshot.pointOfDelivery).toBeNull();
    expect(snapshot.meterSerialNumber).toBeNull();
    // 12.5 kWh -> 12_500_000 mWh
    expect(snapshot.cumulativeEnergy).toBe(12_500_000);
  });

  it("reports mapped meterSerialNumber and pointOfDelivery", async () => {
    const snapshot = await bringUp(
      sensorEntity("sensor.grid_meter_energy", "3", "energy", "kWh"),
      {
        entityId: "sensor.grid_meter_energy",
        matterDeviceType: "electrical_utility_meter",
        meterSerialNumber: "1EMH0001234567",
        pointOfDelivery: "DE0001234567890123456789012345678",
      },
    );

    expect(snapshot.meterSerialNumber).toBe("1EMH0001234567");
    expect(snapshot.pointOfDelivery).toBe("DE0001234567890123456789012345678");
    expect(snapshot.meterType).toBeNull();
  });

  it("keeps plain energy sensors on ElectricalMeter without an override", async () => {
    const snapshot = await bringUp(
      sensorEntity("sensor.grid_energy", "12.5", "energy", "kWh"),
    );

    expect(snapshot.deviceTypes).toContain(ELECTRICAL_METER);
    expect(snapshot.deviceTypes).not.toContain(ELECTRICAL_UTILITY_METER);
  });
});
