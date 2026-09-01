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

// #470: an oven exposed as a template climate in a Fahrenheit install has
// max_temp 500. Registration turned that into 50000 without a unit
// conversion, above the int16 ceiling, so matter.js rejected the thermostat
// state before the first update could write the converted values and the
// endpoint never mounted. Registration values only have to be valid, the
// update pass owns the real numbers.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate-470-"));
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
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°F" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function oven(
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: "climate.lower_oven",
    state: "off",
    attributes: {
      friendly_name: "Lower Oven",
      hvac_modes: ["heat", "off"],
      min_temp: 100,
      max_temp: 500,
      target_temp_step: 1,
      current_temperature: null,
      hvac_action: "off",
      supported_features: 385,
      ...attributes,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "climate.lower_oven", state: state as any };
}

async function bringOnline(attributes: Record<string, unknown>) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "climate-470-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    ClimateDevice({ entity: oven(attributes) } as never),
    { id: "lower_oven" },
  );
  try {
    await aggregator.add(endpoint);
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const t = (endpoint.state as any).thermostat;
    return {
      minHeat: t.minHeatSetpointLimit as number,
      maxHeat: t.maxHeatSetpointLimit as number,
      absMinHeat: t.absMinHeatSetpointLimit as number,
      absMaxHeat: t.absMaxHeatSetpointLimit as number,
      heatingSetpoint: t.occupiedHeatingSetpoint as number,
      localTemperature: t.localTemperature as number | null,
    };
  } finally {
    await server.close();
  }
}

describe("a Fahrenheit oven mounts as a thermostat (#470)", () => {
  it("survives max_temp 500 and a 375 setpoint and ends up converted", async () => {
    const t = await bringOnline({ temperature: 375 });
    // 100F = 37.78C, 500F = 260C, 375F = 190.56C, plus the +1 nudge the
    // thermostat applies to a setpoint while the entity is off (#176)
    expect(t.minHeat).toBe(3778);
    expect(t.maxHeat).toBe(26000);
    expect(t.absMinHeat).toBe(3778);
    expect(t.absMaxHeat).toBe(26000);
    expect(t.heatingSetpoint).toBe(19057);
  });

  it("mounts with the template default setpoint 21 and no current temperature", async () => {
    const t = await bringOnline({ temperature: 21 });
    expect(t.maxHeat).toBe(26000);
    expect(t.minHeat).toBeLessThanOrEqual(t.heatingSetpoint);
    expect(t.heatingSetpoint).toBeLessThanOrEqual(t.maxHeat);
    // no current temperature: the fallback is the clamped setpoint, not the
    // raw 21 F target that would read as -6 C
    expect(t.localTemperature).toBe(3778);
  });
});
