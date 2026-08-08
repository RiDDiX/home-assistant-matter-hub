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
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

// #214: a composed sensor lists every measurement device type in the descriptor
// so controllers like SmartThings show each value. That override only lands when
// a Descriptor behavior is part of the endpoint, otherwise only the primary
// type plus BridgedNode reach the controller.

const TEMP = 0x0302;
const HUMIDITY = 0x0307;
const PRESSURE = 0x0305;

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-sensor-214-"));
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

// Mount a composed temperature sensor and return the device types the
// controller actually sees (the runtime descriptor deviceTypeList).
async function mountedDeviceTypes(
  mapping: EntityMappingConfig,
): Promise<number[]> {
  const type = createLegacyEndpointType(tempEntity(), mapping);
  if (!type) {
    throw new Error("no endpoint type");
  }
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "sensor-214-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "sensor" });
  await aggregator.add(endpoint);

  let list: number[] = [];
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read descriptor state
    const dtl = (agent as any).descriptor.state.deviceTypeList as Array<{
      deviceType: number;
    }>;
    list = dtl.map((d) => Number(d.deviceType));
  });
  await server.close().catch(() => {});
  return list;
}

describe("composed sensor device types (#214)", () => {
  it("lists temperature and humidity", async () => {
    const types = await mountedDeviceTypes({
      entityId: "sensor.temp",
      humidityEntity: "sensor.hum",
    });
    expect(types).toContain(TEMP);
    expect(types).toContain(HUMIDITY);
  });

  it("lists temperature and pressure", async () => {
    const types = await mountedDeviceTypes({
      entityId: "sensor.temp",
      pressureEntity: "sensor.press",
    });
    expect(types).toContain(TEMP);
    expect(types).toContain(PRESSURE);
  });
});
