import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { FanControl } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ClimateDevice } from "./index.js";

// #436 review: a climate whose only fan_mode is "auto" has zero speed presets,
// and the speedMax fallback padded that to 3, inventing speeds the entity
// cannot accept. Matter only requires SpeedMax >= 1.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate436-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function climateEntity(
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: "climate.ac",
    state: "off",
    attributes: { friendly_name: "AC", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "climate.ac", state: state as any };
}

async function bringUp(attributes: Record<string, unknown>) {
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "climate436-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    ClimateDevice({ entity: climateEntity(attributes) } as never),
    { id: "ac" },
  );
  await aggregator.add(endpoint);
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const fc = (endpoint.state as any).fanControl;
  const snapshot = {
    auto: fc.featureMap.auto as boolean,
    sequence: fc.fanModeSequence as FanControl.FanModeSequence,
    speedMax: fc.speedMax as number,
  };
  await server.close().catch(() => {});
  return snapshot;
}

describe("climate with an auto-only fan mode list (#436)", () => {
  it("reports a single speed instead of three invented ones", async () => {
    const fc = await bringUp({
      hvac_modes: ["off", "cool"],
      min_temp: 16,
      max_temp: 30,
      temperature: 22,
      current_temperature: 24,
      supported_features: 9, // TARGET_TEMPERATURE | FAN_MODE
      fan_modes: ["auto"],
      fan_mode: "auto",
    });
    expect(fc.auto).toBe(true);
    expect(fc.speedMax).toBe(1);
    expect(fc.sequence).toBe(FanControl.FanModeSequence.OffHighAuto);
  });
});
