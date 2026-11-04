import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { createLegacyEndpointType } from "../endpoints/legacy/create-legacy-endpoint-type.js";

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-humidity-"));
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

async function mount(value: string, unit: string): Promise<number | null> {
  const info: HomeAssistantEntityInformation = {
    entity_id: "sensor.bath",
    state: {
      entity_id: "sensor.bath",
      state: value,
      attributes: { device_class: "humidity", unit_of_measurement: unit },
      context: { id: "c" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
  };
  const type = createLegacyEndpointType(info, {
    entityId: "sensor.bath",
    matterDeviceType: "humidity_sensor",
  });
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `humidity-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "humidity" });
  await aggregator.add(endpoint);
  return endpoint.act(
    (agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: read the cluster state
      (agent as any).relativeHumidityMeasurement.state.measuredValue,
  );
}

describe("humidity sensor readings", () => {
  it("clamps a saturated sensor to 100 %", async () => {
    expect(await mount("100.4", "%")).toBe(10000);
  });
});
