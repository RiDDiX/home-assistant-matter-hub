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

// #435: target_temp_low/high were read in every hvac mode. Integrations that
// park the range at a stale value while running on "temperature" made the
// setpoint reported to controllers collapse onto that parked value.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate435sp-"));
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
  state: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const full = {
    entity_id: "climate.ac",
    state,
    attributes: { friendly_name: "AC", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "climate.ac", state: full as any };
}

async function bringOnline(state: string, attributes: Record<string, unknown>) {
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°F" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "climate435sp-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);

  const type = ClimateDevice({
    entity: climateEntity(state, attributes),
  } as never);
  const endpoint = new Endpoint(type, { id: "ac" });
  await aggregator.add(endpoint);

  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const t = (endpoint.state as any).thermostat;
  const snap = {
    occupiedHeatingSetpoint: t.occupiedHeatingSetpoint as number | undefined,
    occupiedCoolingSetpoint: t.occupiedCoolingSetpoint as number | undefined,
  };
  await server.close().catch(() => {});
  return snap;
}

// TARGET_TEMPERATURE (1) + TARGET_TEMPERATURE_RANGE (2). The entity advertises
// heat_cool but is currently running in cool on the single "temperature" value.
const base = {
  hvac_modes: ["off", "heat", "cool", "heat_cool"],
  min_temp: 45,
  max_temp: 95,
  current_temperature: 72,
  supported_features: 3,
};

describe("setpoints follow the active hvac mode (#435)", () => {
  it("uses temperature, not the parked range, in cool mode", async () => {
    const t = await bringOnline("cool", {
      ...base,
      temperature: 75,
      target_temp_low: 61,
      target_temp_high: 61,
    });
    // 75°F, not the 61°F the integration left in target_temp_low/high.
    expect(t.occupiedCoolingSetpoint).toBe(2389);
  });

  it("uses temperature, not the parked range, in heat mode", async () => {
    const t = await bringOnline("heat", {
      ...base,
      temperature: 75,
      target_temp_low: 61,
      target_temp_high: 61,
    });
    expect(t.occupiedHeatingSetpoint).toBe(2389);
  });

  it("keeps reading the range in heat_cool mode", async () => {
    const t = await bringOnline("heat_cool", {
      ...base,
      target_temp_low: 68,
      target_temp_high: 75,
    });
    expect(t.occupiedHeatingSetpoint).toBe(2000);
    expect(t.occupiedCoolingSetpoint).toBe(2389);
  });

  it("falls back to the range when temperature is absent in cool mode", async () => {
    const t = await bringOnline("cool", {
      ...base,
      target_temp_low: 68,
      target_temp_high: 75,
    });
    expect(t.occupiedCoolingSetpoint).toBe(2389);
    expect(t.occupiedHeatingSetpoint).toBe(2000);
  });

  // The registration-time initial state is all a controller sees until the
  // first available update, the thermostat leaves state untouched while the
  // entity is unavailable.
  it("registers temperature, not the parked range, when unavailable at start", async () => {
    const t = await bringOnline("unavailable", {
      hvac_modes: ["off", "heat", "cool", "heat_cool"],
      min_temp: 7,
      max_temp: 35,
      current_temperature: 22,
      supported_features: 3,
      temperature: 24,
      target_temp_low: 16,
      target_temp_high: 16,
    });
    // 24°C from temperature, not the parked 16. The extra centidegree is the
    // Off-state nudge (#176), unavailable resolves to Off at start.
    expect(t.occupiedCoolingSetpoint).toBe(2401);
    expect(t.occupiedHeatingSetpoint).toBe(2401);
  });

  it("keeps the range for a heat_cool entity available at start", async () => {
    const t = await bringOnline("heat_cool", {
      ...base,
      temperature: 61,
      target_temp_low: 68,
      target_temp_high: 75,
    });
    expect(t.occupiedHeatingSetpoint).toBe(2000);
    expect(t.occupiedCoolingSetpoint).toBe(2389);
  });
});
