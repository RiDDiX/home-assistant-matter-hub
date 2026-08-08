import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ClimateDevice } from "./index.js";

// #381: a cooling-only thermostat (hvac_modes ["off","cool"]) that briefly
// reports state "heat" maps systemMode to Heat, which isn't allowed there and
// used to crash init (code 135) and drop the device. It must be clamped.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate381-"));
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
    id: "climate381-node",
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
  // Throws (conformance rollback) before the fix.
  await aggregator.add(endpoint);
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const t = (endpoint.state as any).thermostat;
  const systemMode = t.systemMode as number;
  await server.close();
  return systemMode;
}

describe("thermostat systemMode stays conformant with the feature set (#381)", () => {
  it("brings a cooling-only thermostat online when state wants Heat", async () => {
    const systemMode = await bringOnline("heat", {
      hvac_modes: ["off", "cool"],
      min_temp: 16,
      max_temp: 30,
      temperature: 24,
      current_temperature: 20,
      supported_features: 1,
    });
    // Heat (4) would be non-conformant on a cooling-only base; it must be
    // clamped to a mode the featureMap allows.
    expect(systemMode).not.toBe(Thermostat.SystemMode.Heat);
  });
});
