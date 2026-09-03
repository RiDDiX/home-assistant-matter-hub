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
import { updateEntityState } from "../endpoints/update-entity-state.js";

// The reading a controller gets must be the Home Assistant value and nothing
// else: no placeholder, no unit surprise, and no frozen last-good value when
// the sensor leaves the declared measurement window.

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-temp-"));
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

function state(value: string, unit = "°C") {
  return {
    entity_id: "sensor.temp",
    state: value,
    attributes: {
      friendly_name: "Temp",
      device_class: "temperature",
      unit_of_measurement: unit,
    },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

async function mount(value: string, unit = "°C") {
  const info: HomeAssistantEntityInformation = {
    entity_id: "sensor.temp",
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    state: state(value, unit) as any,
  };
  const type = createLegacyEndpointType(info, {
    entityId: "sensor.temp",
    matterDeviceType: "temperature_sensor",
  });
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `temp-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "temp" });
  await aggregator.add(endpoint);
  return endpoint;
}

async function measured(endpoint: Endpoint): Promise<number | null> {
  return endpoint.act(
    (agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: read the cluster state
      (agent as any).temperatureMeasurement.state.measuredValue,
  );
}

async function push(endpoint: Endpoint, value: string, unit = "°C") {
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  await updateEntityState(endpoint, state(value, unit) as any);
}

describe("temperature sensor readings", () => {
  it("reports the Home Assistant value, not a placeholder", async () => {
    const endpoint = await mount("15");
    expect(await measured(endpoint)).toBe(1500);
  });

  it("follows every update", async () => {
    const endpoint = await mount("15");
    await push(endpoint, "16.5");
    expect(await measured(endpoint)).toBe(1650);
    await push(endpoint, "-7.25");
    expect(await measured(endpoint)).toBe(-725);
  });

  it("converts Fahrenheit", async () => {
    const endpoint = await mount("59", "°F");
    expect(await measured(endpoint)).toBe(1500);
  });

  it("reports null instead of a stale value when the entity is unavailable", async () => {
    const endpoint = await mount("15");
    await push(endpoint, "unavailable");
    expect(await measured(endpoint)).toBeNull();
  });

  it("keeps following a sensor that leaves the typical -40..125C window", async () => {
    const endpoint = await mount("20");
    await push(endpoint, "180");
    expect(await measured(endpoint)).toBe(18000);
    await push(endpoint, "-60");
    expect(await measured(endpoint)).toBe(-6000);
  });
});
