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
import { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../aggregator-endpoint.js";
import { createLegacyEndpointType } from "./create-legacy-endpoint-type.js";

// #484: matter.js adds ElectricalSensor (0x0510) itself once PowerTopology
// sits next to a measurement cluster.

const ON_OFF_PLUG_IN_UNIT = 0x010a;
const ON_OFF_LIGHT = 0x0100;
const ELECTRICAL_SENSOR = 0x0510;
const BRIDGED_NODE = 0x0013;

const ELECTRICAL_POWER_MEASUREMENT = 0x0090;
const ELECTRICAL_ENERGY_MEASUREMENT = 0x0091;
const POWER_TOPOLOGY = 0x009c;

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-auto-electrical-"));
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
    getNumericState: (id: string) =>
      id === "sensor.plug_power"
        ? 42
        : id === "sensor.plug_energy"
          ? 7.5
          : null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function entity(entityId: string): HomeAssistantEntityInformation {
  const state = {
    entity_id: entityId,
    state: "on",
    attributes: { friendly_name: entityId },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: state as any };
}

interface Snapshot {
  deviceTypes: { deviceType: number; revision: number }[];
  serverList: number[];
  activePower: number | null;
  cumulativeEnergy: number | null;
}

async function bringUp(
  entityId: string,
  mapping: EntityMappingConfig,
): Promise<Snapshot> {
  const type = createLegacyEndpointType(entity(entityId), mapping);
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `auto-electrical-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "auto-electrical" });
  await aggregator.add(endpoint);

  let snapshot: Snapshot | undefined;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const a = agent as any;
    const dtl = a.descriptor.state.deviceTypeList as {
      deviceType: number;
      revision: number;
    }[];
    const power = a.electricalPowerMeasurement?.state.activePower;
    const energy =
      a.electricalEnergyMeasurement?.state.cumulativeEnergyImported?.energy;
    snapshot = {
      deviceTypes: dtl.map((d) => ({
        deviceType: Number(d.deviceType),
        revision: Number(d.revision),
      })),
      serverList: (a.descriptor.state.serverList as number[]).map(Number),
      activePower: power == null ? null : Number(power),
      cumulativeEnergy: energy == null ? null : Number(energy),
    };
  });
  if (!snapshot) throw new Error("no snapshot");
  return snapshot;
}

describe("auto-mapped power/energy bring-up (#484)", () => {
  it("gives a switch the ElectricalSensor device type and both measurements", async () => {
    const snapshot = await bringUp("switch.plug", {
      entityId: "switch.plug",
      powerEntity: "sensor.plug_power",
      energyEntity: "sensor.plug_energy",
    });

    expect(snapshot.deviceTypes).toEqual([
      { deviceType: ON_OFF_PLUG_IN_UNIT, revision: 4 },
      { deviceType: ELECTRICAL_SENSOR, revision: 1 },
      { deviceType: BRIDGED_NODE, revision: 3 },
    ]);
    expect(snapshot.serverList).toContain(ELECTRICAL_POWER_MEASUREMENT);
    expect(snapshot.serverList).toContain(ELECTRICAL_ENERGY_MEASUREMENT);
    expect(snapshot.serverList).toContain(POWER_TOPOLOGY);
    // 42 W -> mW, 7.5 kWh -> mWh
    expect(snapshot.activePower).toBe(42_000);
    expect(snapshot.cumulativeEnergy).toBe(7_500_000);
  });

  it("gives a light the same treatment", async () => {
    const snapshot = await bringUp("light.lamp", {
      entityId: "light.lamp",
      powerEntity: "sensor.plug_power",
      energyEntity: "sensor.plug_energy",
    });

    expect(snapshot.deviceTypes.map((d) => d.deviceType)).toEqual([
      ON_OFF_LIGHT,
      ELECTRICAL_SENSOR,
      BRIDGED_NODE,
    ]);
    expect(snapshot.activePower).toBe(42_000);
    expect(snapshot.cumulativeEnergy).toBe(7_500_000);
  });

  // Apple only shows wattage on outlets (#484)
  it("keeps the measurements when a light is exposed as an outlet", async () => {
    const snapshot = await bringUp("light.lamp", {
      entityId: "light.lamp",
      matterDeviceType: "on_off_plugin_unit",
      powerEntity: "sensor.plug_power",
      energyEntity: "sensor.plug_energy",
    });

    expect(snapshot.deviceTypes.map((d) => d.deviceType)).toEqual([
      ON_OFF_PLUG_IN_UNIT,
      ELECTRICAL_SENSOR,
      BRIDGED_NODE,
    ]);
    expect(snapshot.serverList).toContain(ELECTRICAL_POWER_MEASUREMENT);
    expect(snapshot.serverList).toContain(ELECTRICAL_ENERGY_MEASUREMENT);
    expect(snapshot.activePower).toBe(42_000);
    expect(snapshot.cumulativeEnergy).toBe(7_500_000);
  });

  it("keeps the ElectricalSensor device type off an unmapped switch", async () => {
    const snapshot = await bringUp("switch.plain", {
      entityId: "switch.plain",
    });

    expect(snapshot.deviceTypes.map((d) => d.deviceType)).toEqual([
      ON_OFF_PLUG_IN_UNIT,
      BRIDGED_NODE,
    ]);
    expect(snapshot.serverList).not.toContain(ELECTRICAL_POWER_MEASUREMENT);
    expect(snapshot.serverList).not.toContain(POWER_TOPOLOGY);
  });

  it("adds the device type for an energy-only mapping", async () => {
    const snapshot = await bringUp("switch.meter_only", {
      entityId: "switch.meter_only",
      energyEntity: "sensor.plug_energy",
    });

    expect(snapshot.deviceTypes.map((d) => d.deviceType)).toContain(
      ELECTRICAL_SENSOR,
    );
    expect(snapshot.serverList).toContain(ELECTRICAL_ENERGY_MEASUREMENT);
    expect(snapshot.serverList).not.toContain(ELECTRICAL_POWER_MEASUREMENT);
    expect(snapshot.cumulativeEnergy).toBe(7_500_000);
  });
});
