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

// #384: an old build persisted cooling/auto attributes on a thermostat that now
// derives without those features. matter.js rejects the leftover on init
// (Conformance "COOL"/"AUTO", 135) and drops the device, so preInitialize must
// clear the inactive feature's state.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate384-"));
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
    entity_id: "climate.rad",
    state,
    attributes: { friendly_name: "Rad", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "climate.rad", state: full as any };
}

// Mount a thermostat with a seeded stale attribute, like 0.17 persistence would
// surface a leftover from a boot under a different feature set.
async function bringOnline(
  state: string,
  attributes: Record<string, unknown>,
  thermostatSeed: Record<string, unknown>,
) {
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "climate384-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);

  let type = ClimateDevice({
    entity: climateEntity(state, attributes),
  } as never);
  // biome-ignore lint/suspicious/noExplicitAny: set initial cluster state
  type = (type as any).set({ thermostat: thermostatSeed });

  const endpoint = new Endpoint(type, { id: "rad" });
  // Rolls back with code 135 before the fix.
  await aggregator.add(endpoint);

  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const t = (endpoint.state as any).thermostat;
  const snap = {
    occupiedCoolingSetpoint: t.occupiedCoolingSetpoint as number | undefined,
    minSetpointDeadBand: t.minSetpointDeadBand as number | undefined,
    thermostatRunningMode: t.thermostatRunningMode as number | undefined,
  };
  await server.close().catch(() => {});
  return snap;
}

const heatingOnly = {
  hvac_modes: ["off", "heat", "auto"],
  min_temp: 7,
  max_temp: 30,
  temperature: 21,
  current_temperature: 19,
  supported_features: 1,
};

describe("thermostat survives stale state from an old feature set (#384)", () => {
  it("clears a leftover occupiedCoolingSetpoint on a heating-only device", async () => {
    const t = await bringOnline("heat", heatingOnly, {
      occupiedCoolingSetpoint: 2400,
    });
    expect(t).toBeDefined();
    expect(t.occupiedCoolingSetpoint).toBeUndefined();
  });

  it("clears leftover AutoMode attributes on a non-AutoMode device", async () => {
    // [off,heat,cool] without heat_cool builds Heating+Cooling without AutoMode,
    // so a persisted minSetpointDeadBand / thermostatRunningMode (AUTO) would
    // otherwise crash with Conformance "AUTO" (135).
    const t = await bringOnline(
      "heat",
      { ...heatingOnly, hvac_modes: ["off", "heat", "cool"] },
      { minSetpointDeadBand: 0, thermostatRunningMode: 1 },
    );
    expect(t).toBeDefined();
    expect(t.minSetpointDeadBand).toBeUndefined();
    expect(t.thermostatRunningMode).toBeUndefined();
  });
});
