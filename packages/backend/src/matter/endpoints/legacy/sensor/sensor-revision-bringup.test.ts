import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import {
  HumiditySensorDevice,
  PressureSensorDevice,
  TemperatureSensorDevice,
} from "@matter/main/devices";
import { BridgedNodeEndpoint } from "@matter/main/endpoints";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

// Merged sensors list their device types explicitly (#214), so the revisions
// must follow the matter.js model like a plain sensor on the same bridge.

const temp = {
  deviceType: Number(TemperatureSensorDevice.deviceType),
  revision: TemperatureSensorDevice.deviceRevision,
};
const humidity = {
  deviceType: Number(HumiditySensorDevice.deviceType),
  revision: HumiditySensorDevice.deviceRevision,
};
const pressure = {
  deviceType: Number(PressureSensorDevice.deviceType),
  revision: PressureSensorDevice.deviceRevision,
};
const bridged = {
  deviceType: Number(BridgedNodeEndpoint.deviceType),
  revision: BridgedNodeEndpoint.deviceRevision,
};

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-sensor-revision-"));
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
    getNumericState: () => 55,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tempEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "sensor.temp",
    state: "21",
    attributes: {
      friendly_name: "Temp",
      device_class: "temperature",
      unit_of_measurement: "°C",
    },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "sensor.temp", state: state as any };
}

// Mount a composed temperature sensor and return its runtime descriptor
// deviceTypeList.
async function mountedDeviceTypes(
  mapping: EntityMappingConfig,
): Promise<Array<{ deviceType: number; revision: number }>> {
  const type = createLegacyEndpointType(tempEntity(), mapping);
  if (!type) {
    throw new Error("no endpoint type");
  }
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "sensor-revision-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "sensor" });
  await aggregator.add(endpoint);

  let list: Array<{ deviceType: number; revision: number }> = [];
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read descriptor state
    const dtl = (agent as any).descriptor.state.deviceTypeList as Array<{
      deviceType: number;
      revision: number;
    }>;
    list = dtl.map((d) => ({
      deviceType: Number(d.deviceType),
      revision: d.revision,
    }));
  });
  await server.close().catch(() => {});
  return list;
}

describe("merged sensor device type revisions", () => {
  it.each([
    ["humidity", { humidityEntity: "sensor.hum" }, [temp, humidity]],
    ["pressure", { pressureEntity: "sensor.press" }, [temp, pressure]],
    [
      "humidity and pressure",
      { humidityEntity: "sensor.hum", pressureEntity: "sensor.press" },
      [temp, humidity, pressure],
    ],
    [
      "humidity, pressure and battery",
      {
        humidityEntity: "sensor.hum",
        pressureEntity: "sensor.press",
        batteryEntity: "sensor.bat",
      },
      [temp, humidity, pressure],
    ],
  ])("temperature with %s uses the model revisions", async (_, extra, expected) => {
    const list = await mountedDeviceTypes({
      entityId: "sensor.temp",
      ...extra,
    });
    // The battery shape also lists PowerSource, which is not under test here.
    const sensorTypes = [temp, humidity, pressure, bridged].map(
      (d) => d.deviceType,
    );
    const listed = list.filter((d) => sensorTypes.includes(d.deviceType));
    expect(listed).toEqual(expect.arrayContaining([...expected, bridged]));
    expect(listed).toHaveLength(expected.length + 1);
  });
});
