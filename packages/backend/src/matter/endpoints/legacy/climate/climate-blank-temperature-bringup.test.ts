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

// Template, MQTT and IR climates can report a blank string temperature. It must
// read as missing, not as 0 degC, so the setpoint fallback chain still applies.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate-blank-"));
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
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "climate-blank-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    ClimateDevice({ entity: climateEntity(state, attributes) } as never),
    { id: "ac" },
  );
  await aggregator.add(endpoint);
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const t = (endpoint.state as any).thermostat;
  const result = {
    localTemperature: t.localTemperature as number | null,
    heating: t.occupiedHeatingSetpoint as number,
  };
  await server.close();
  return result;
}

const base = {
  hvac_modes: ["off", "heat"],
  min_temp: 7,
  max_temp: 30,
  supported_features: 1,
};

describe("blank climate temperature attributes", () => {
  it("falls back to the setpoint for a blank current_temperature", async () => {
    const { localTemperature } = await bringOnline("heat", {
      ...base,
      temperature: 22,
      current_temperature: "",
    });
    expect(localTemperature).toBe(2200);
  });

  it("falls back past a blank temperature like a null one", async () => {
    const blank = await bringOnline("heat", {
      ...base,
      temperature: "",
      target_temp_low: 20,
      current_temperature: 19,
    });
    const missing = await bringOnline("heat", {
      ...base,
      temperature: null,
      target_temp_low: 20,
      current_temperature: 19,
    });
    expect(blank.heating).toBe(2000);
    expect(blank.heating).toBe(missing.heating);
  });
});
