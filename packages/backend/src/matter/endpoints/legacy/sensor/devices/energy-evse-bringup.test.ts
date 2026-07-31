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

// #419: an EnergyEvse (0x050C) whose mandatory EnergyEvse + EnergyEvseMode
// clusters are not seeded throws AggregateError on mount. This brings the real
// endpoint online through createLegacyEndpointType and checks the seeded wire
// values plus the command list that only appears once the handlers exist.

const ENERGY_EVSE = 0x050c; // 1292
const ELECTRICAL_SENSOR = 0x0510; // 1296

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-evse-"));
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

function statusEntity(
  entityId: string,
  value: string,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: entityId,
    state: value,
    attributes: { friendly_name: entityId },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: state as any };
}

interface Snapshot {
  deviceTypes: number[];
  supplyState: number;
  faultState: number;
  state: number | null;
  currentMode: number;
  supportedModes: number;
  acceptedCommands: number[];
  powerSourceStatus: number | null;
  hasPowerMeasurement: boolean;
  hasEnergyMeasurement: boolean;
}

async function bringUp(
  entity: HomeAssistantEntityInformation,
  mapping?: EntityMappingConfig,
): Promise<Snapshot> {
  const type = createLegacyEndpointType(entity, {
    entityId: entity.entity_id,
    matterDeviceType: "evse",
    ...mapping,
  });
  if (!type) {
    throw new Error("no endpoint type");
  }
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `evse-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "evse" });
  await aggregator.add(endpoint);

  const snapshot: Snapshot = {
    deviceTypes: [],
    supplyState: Number.NaN,
    faultState: Number.NaN,
    state: null,
    currentMode: Number.NaN,
    supportedModes: 0,
    acceptedCommands: [],
    powerSourceStatus: null,
    hasPowerMeasurement: false,
    hasEnergyMeasurement: false,
  };
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const a = agent as any;
    const dtl = a.descriptor.state.deviceTypeList as Array<{
      deviceType: number;
    }>;
    snapshot.deviceTypes = dtl.map((d) => Number(d.deviceType));
    snapshot.supplyState = Number(a.energyEvse.state.supplyState);
    snapshot.faultState = Number(a.energyEvse.state.faultState);
    snapshot.state =
      a.energyEvse.state.state == null
        ? null
        : Number(a.energyEvse.state.state);
    snapshot.acceptedCommands = (
      a.energyEvse.state.acceptedCommandList as number[]
    ).map((c) => Number(c));
    snapshot.currentMode = Number(a.energyEvseMode.state.currentMode);
    snapshot.supportedModes = a.energyEvseMode.state.supportedModes.length;
    snapshot.powerSourceStatus =
      a.powerSource?.state.status == null
        ? null
        : Number(a.powerSource.state.status);
    snapshot.hasPowerMeasurement =
      a.electricalPowerMeasurement?.state.activePower != null;
    snapshot.hasEnergyMeasurement =
      a.electricalEnergyMeasurement?.state.cumulativeEnergyImported != null;
  });
  return snapshot;
}

describe("energy evse bring-up (#419 seeding)", () => {
  it("mounts a status sensor as EnergyEvse without AggregateError", async () => {
    const snapshot = await bringUp(
      statusEntity("sensor.wallbox_status", "idle"),
    );

    expect(snapshot.deviceTypes).toContain(ENERGY_EVSE);
    // supplyState / faultState seeded so the endpoint doesn't brick on mount.
    expect(snapshot.supplyState).toBe(0); // Disabled
    expect(snapshot.faultState).toBe(0); // NoError
  });

  it("seeds a single Manual mode selected as currentMode 1", async () => {
    const snapshot = await bringUp(
      statusEntity("sensor.wallbox_status", "idle"),
    );
    expect(snapshot.supportedModes).toBe(1);
    expect(snapshot.currentMode).toBe(1);
  });

  it("advertises Disable (1) and EnableCharging (2) once handlers exist", async () => {
    const snapshot = await bringUp(
      statusEntity("sensor.wallbox_status", "idle"),
    );
    expect(snapshot.acceptedCommands).toContain(1);
    expect(snapshot.acceptedCommands).toContain(2);
  });

  it("maps a charging status to PluggedInCharging + ChargingEnabled", async () => {
    const snapshot = await bringUp(
      statusEntity("sensor.wallbox_status", "charging"),
    );
    expect(snapshot.state).toBe(3); // PluggedInCharging
    expect(snapshot.supplyState).toBe(1); // ChargingEnabled
  });

  it("composes the EnergyEvse + ElectricalSensor device types with a seeded power source", async () => {
    // No mapping at all: the mandatory composition must still stand up.
    const snapshot = await bringUp(
      statusEntity("sensor.wallbox_status", "idle"),
    );

    // Both device types are advertised so controllers render the measurements.
    expect(snapshot.deviceTypes).toContain(ENERGY_EVSE);
    expect(snapshot.deviceTypes).toContain(ELECTRICAL_SENSOR);

    // Wired PowerSource seeded Active so the mandatory attrs don't brick.
    expect(snapshot.powerSourceStatus).toBe(1); // Active

    // Measurement clusters are mounted unconditionally with safe defaults.
    expect(snapshot.hasPowerMeasurement).toBe(true);
    expect(snapshot.hasEnergyMeasurement).toBe(true);
  });
});
