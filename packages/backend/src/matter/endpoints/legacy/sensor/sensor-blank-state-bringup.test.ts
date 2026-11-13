import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
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

let dir: string;
let env: Environment;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-sensor-blank-"));
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

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entity(
  deviceClass: string,
  unit: string,
  value: string,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: "sensor.x",
    state: value,
    attributes: {
      friendly_name: "X",
      device_class: deviceClass,
      unit_of_measurement: unit,
    },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "sensor.x", state: state as any };
}

const sensors = [
  ["temperature", "°C", "temperatureMeasurement", "measuredValue"],
  ["humidity", "%", "relativeHumidityMeasurement", "measuredValue"],
  ["battery", "%", "powerSource", "batPercentRemaining"],
] as const;

async function read(
  deviceClass: string,
  unit: string,
  value: string,
  cluster: string,
  attribute: string,
): Promise<unknown> {
  const type = createLegacyEndpointType(entity(deviceClass, unit, value), {
    entityId: "sensor.x",
  });
  if (!type) {
    throw new Error("no endpoint type");
  }
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `sensor-blank-node-${n++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  try {
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(type, { id: "sensor" });
    await aggregator.add(endpoint);
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    return (endpoint.state as any)[cluster][attribute];
  } finally {
    await server.close().catch(() => {});
  }
}

describe("sensor with a blank state", () => {
  it.each(
    sensors,
  )("%s reports no value for a blank state", async (deviceClass, unit, cluster, attribute) => {
    const unknown = await read(
      deviceClass,
      unit,
      "unknown",
      cluster,
      attribute,
    );
    expect(unknown).not.toBe(0);
    expect(await read(deviceClass, unit, "", cluster, attribute)).toBe(unknown);
    expect(await read(deviceClass, unit, " ", cluster, attribute)).toBe(
      unknown,
    );
  });

  it.each(
    sensors,
  )("%s reports 0 for a state of 0", async (deviceClass, unit, cluster, attribute) => {
    expect(await read(deviceClass, unit, "0", cluster, attribute)).toBe(0);
  });
});
