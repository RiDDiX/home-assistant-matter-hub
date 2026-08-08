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

// #381 follow-up: matter.js validates BOTH Heat and Cool setpoint limits on
// init, no matter the featureMap. A device that used to be heating can carry a
// leftover maxHeatSetpointLimit; on a cooling-only rebuild the Heat absMax falls
// back to the matter default (3000), so a stale 3500 trips
// maxHeatSetpointLimit > absMaxHeatSetpointLimit (code 135), rolls back init and
// drops the device. preInitialize must clear the inactive feature's stale limits.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate-stale-"));
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

async function bringOnline(
  state: string,
  attributes: Record<string, unknown>,
  thermostatSeed?: Record<string, unknown>,
) {
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "climate-stale-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  let type = ClimateDevice({
    entity: climateEntity(state, attributes),
  } as never);
  if (thermostatSeed) {
    // Seed a stale Heat limit the way 0.17 persistence would surface a leftover
    // from a prior heating boot.
    // biome-ignore lint/suspicious/noExplicitAny: set initial cluster state
    type = (type as any).set({ thermostat: thermostatSeed });
  }
  const endpoint = new Endpoint(type, { id: "ac" });
  // Rolls back with code 135 before the fix.
  await aggregator.add(endpoint);
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const t = (endpoint.state as any).thermostat;
  const snap = {
    maxHeat: t.maxHeatSetpointLimit as number | undefined,
    absMaxHeat: t.absMaxHeatSetpointLimit as number | undefined,
    maxCool: t.maxCoolSetpointLimit as number | undefined,
    absMaxCool: t.absMaxCoolSetpointLimit as number | undefined,
  };
  await server.close();
  return snap;
}

describe("cooling-only thermostat with stale Heat setpoint limits (#381)", () => {
  it("comes online when a leftover maxHeatSetpointLimit exceeds the Heat absMax", async () => {
    const snap = await bringOnline(
      "cool",
      {
        hvac_modes: ["off", "cool"],
        min_temp: 16,
        max_temp: 30,
        temperature: 24,
        current_temperature: 20,
        supported_features: 1,
      },
      { maxHeatSetpointLimit: 3500 },
    );
    // Mount must not roll back. The stale Heat max must not be left above the
    // Heat absMax (matter default 3000), or init crashes (code 135).
    expect(snap).toBeDefined();
    if (snap.maxHeat !== undefined) {
      expect(snap.maxHeat).toBeLessThanOrEqual(snap.absMaxHeat as number);
    }
  });

  it("comes online when a leftover maxCoolSetpointLimit exceeds the Cool absMax", async () => {
    const snap = await bringOnline(
      "heat",
      {
        hvac_modes: ["off", "heat"],
        min_temp: 7,
        max_temp: 35,
        temperature: 21,
        current_temperature: 19,
        supported_features: 1,
      },
      { maxCoolSetpointLimit: 3500 },
    );
    // Same problem in the other direction: a heating-only device must not crash
    // on a stale Cool limit above the Cool absMax (matter default 3200).
    expect(snap).toBeDefined();
    if (snap.maxCool !== undefined) {
      expect(snap.maxCool).toBeLessThanOrEqual(snap.absMaxCool as number);
    }
  });

  it("comes online when a leftover absMaxHeatSetpointLimit sits below the Heat max", async () => {
    // Stale Fixed Heat abs limit from legacy storage: absMax 2500 < the Heat max
    // default 3000, so matter.js throws max > absMax unless it is cleared too.
    const snap = await bringOnline(
      "cool",
      {
        hvac_modes: ["off", "cool"],
        min_temp: 16,
        max_temp: 30,
        temperature: 24,
        current_temperature: 20,
        supported_features: 1,
      },
      { absMaxHeatSetpointLimit: 2500 },
    );
    expect(snap).toBeDefined();
  });

  it("comes online when a leftover absMinHeatSetpointLimit sits above the Heat min", async () => {
    // absMin 2000 > the Heat min default 700, the other matter.js crash variant.
    const snap = await bringOnline(
      "cool",
      {
        hvac_modes: ["off", "cool"],
        min_temp: 16,
        max_temp: 30,
        temperature: 24,
        current_temperature: 20,
        supported_features: 1,
      },
      { absMinHeatSetpointLimit: 2000 },
    );
    expect(snap).toBeDefined();
  });
});
