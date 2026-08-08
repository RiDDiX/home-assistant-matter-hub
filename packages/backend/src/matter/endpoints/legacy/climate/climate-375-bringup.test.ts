import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ClimateDevice } from "./index.js";

// #375: a climate entity whose min_temp/max_temp are inconsistent (inverted, or
// mixed Fahrenheit/Celsius) used to make the Thermostat fail init with
// "absMin/min ... code 135", which crashed the whole endpoint and made Google
// Home spawn a duplicate device. The limits must be ordered so init always
// succeeds. This brings the real climate endpoint online and checks the invariant.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate-"));
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

async function bringOnline(
  attributes: Record<string, unknown>,
  temperatureUnit = "°C",
) {
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: temperatureUnit },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "climate-node",
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
  const t = (endpoint.state as any).thermostat;
  // Snapshot the primitives before close(), the state proxy is invalid after.
  const snapshot = {
    absMinHeat: t.absMinHeatSetpointLimit as number,
    minHeat: t.minHeatSetpointLimit as number,
    maxHeat: t.maxHeatSetpointLimit as number,
    absMaxHeat: t.absMaxHeatSetpointLimit as number,
    absMinCool: t.absMinCoolSetpointLimit as number,
    minCool: t.minCoolSetpointLimit as number,
    maxCool: t.maxCoolSetpointLimit as number,
    absMaxCool: t.absMaxCoolSetpointLimit as number,
  };
  await server.close();
  return snapshot;
}

const heatCool = ["off", "auto", "cool", "dry", "heat", "fan_only"];

describe("climate thermostat setpoint limits stay ordered (#375)", () => {
  it("brings a Fahrenheit Midea AC online without a code-135 crash", async () => {
    const t = await bringOnline(
      {
        hvac_modes: heatCool,
        min_temp: 61,
        max_temp: 86,
        temperature: 64,
        current_temperature: 75,
        supported_features: 441,
      },
      "°F",
    );
    expect(t.absMinHeat).toBeLessThanOrEqual(t.minHeat);
    expect(t.minHeat).toBeLessThanOrEqual(t.maxHeat);
    expect(t.maxHeat).toBeLessThanOrEqual(t.absMaxHeat);
    expect(t.absMinCool).toBeLessThanOrEqual(t.minCool);
    expect(t.minCool).toBeLessThanOrEqual(t.maxCool);
    expect(t.maxCool).toBeLessThanOrEqual(t.absMaxCool);
    // The limits must be the converted Celsius values (61F=1611, 86F=3000),
    // not the raw 6100/8600 a failed update() would leave behind. Without this
    // the ordering checks above pass even when the conversion never ran.
    expect(t.minHeat).toBe(1611);
    expect(t.maxHeat).toBe(3000);
    expect(t.absMinHeat).toBe(1611);
    expect(t.absMaxHeat).toBe(3000);
    expect(t.minCool).toBe(1611);
    expect(t.maxCool).toBe(3000);
  });

  it("orders inverted HA limits (min_temp > max_temp) instead of crashing", async () => {
    const t = await bringOnline({
      hvac_modes: heatCool,
      min_temp: 30,
      max_temp: 10,
      temperature: 20,
      current_temperature: 20,
      supported_features: 441,
    });
    expect(t.minHeat).toBeLessThanOrEqual(t.maxHeat);
    expect(t.absMinHeat).toBeLessThanOrEqual(t.minHeat);
    expect(t.maxHeat).toBeLessThanOrEqual(t.absMaxHeat);
  });
});
