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
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

let dir: string;
let env: Environment;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-binary-blank-battery-"));
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
  level: string,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: "binary_sensor.x",
    state: "off",
    attributes: {
      friendly_name: "X",
      device_class: deviceClass,
      battery_level: level,
    },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "binary_sensor.x", state: state as any };
}

async function battery(deviceClass: string, level: string): Promise<unknown> {
  const type = createLegacyEndpointType(entity(deviceClass, level), {
    entityId: "binary_sensor.x",
  });
  if (!type) {
    throw new Error("no endpoint type");
  }
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `binary-blank-battery-node-${n++}`,
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
    return (endpoint.state as any).powerSource.batPercentRemaining;
  } finally {
    await server.close().catch(() => {});
  }
}

// door = contact, moisture = detector (default config), power = on/off
const deviceClasses = [
  "door",
  "moisture",
  "motion",
  "occupancy",
  "power",
  "smoke",
];

describe("binary sensor with a blank battery level", () => {
  it.each(deviceClasses)("%s reports no battery", async (deviceClass) => {
    expect(await battery(deviceClass, "")).toBeNull();
    expect(await battery(deviceClass, " ")).toBeNull();
  });

  it.each(
    deviceClasses,
  )("%s reports 0 for a level of 0", async (deviceClass) => {
    expect(await battery(deviceClass, "0")).toBe(0);
  });
});
