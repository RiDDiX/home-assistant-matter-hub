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

// #419 lesson: an ElectricalMeter (0x0514) whose mandatory measurement clusters
// are not seeded throws AggregateError on mount. This brings the real endpoint
// online through createLegacyEndpointType and checks the wire values.

const ELECTRICAL_METER = 0x0514; // 1300
const SOLAR_POWER = 0x0017; // 23

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-electrical-meter-"));
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
  activePower: number;
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
    id: `electrical-meter-node-${counter++}`,
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
    snapshot.cumulativeEnergy = Number(
      a.electricalEnergyMeasurement?.state.cumulativeEnergyImported?.energy,
    );
  });
  return snapshot;
}

describe("electrical meter bring-up (#419 seeding)", () => {
  it("mounts a power sensor as ElectricalMeter with activePower in mW", async () => {
    const snapshot = await bringUp(
      sensorEntity("sensor.grid_power", "1500", "power", "W"),
    );

    expect(snapshot.deviceTypes).toContain(ELECTRICAL_METER);
    // 1500 W -> 1_500_000 mW
    expect(snapshot.activePower).toBe(1_500_000);
    // energy cluster seeded even though this is a power-only sensor
    expect(snapshot.cumulativeEnergy).toBe(0);
  });

  it("mounts an energy sensor as ElectricalMeter with cumulativeEnergyImported in mWh", async () => {
    const snapshot = await bringUp(
      sensorEntity("sensor.grid_energy", "12.5", "energy", "kWh"),
    );

    expect(snapshot.deviceTypes).toContain(ELECTRICAL_METER);
    // 12.5 kWh -> 12_500_000 mWh
    expect(snapshot.cumulativeEnergy).toBe(12_500_000);
  });

  it("keeps SolarPower for the solar_power override", async () => {
    const snapshot = await bringUp(
      sensorEntity("sensor.pv_power", "800", "power", "W"),
      { entityId: "sensor.pv_power", matterDeviceType: "solar_power" },
    );

    expect(snapshot.deviceTypes).toContain(SOLAR_POWER);
    expect(snapshot.deviceTypes).not.toContain(ELECTRICAL_METER);
  });
});
