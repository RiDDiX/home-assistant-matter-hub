import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// #435: minSetpointDeadBand is quality N with a model default of 2°C (value 20).
// matter.js copies state into internal during its own initialize and a $Changing
// reactor reverts every later write, so the only window to set it is before
// super.initialize(). A "?? 0" there never fires against a stored 20 and the
// device stays locked at a 2°C gap between the heat and cool setpoints.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate435-"));
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

// Mount a thermostat with a deadband seeded as a behavior default, a
// pre-initialize value arriving the way a persisted attribute would. The
// store-file test below covers the real persisted path.
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
    id: "climate435-node",
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
  await aggregator.add(endpoint);

  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const t = (endpoint.state as any).thermostat;
  const snap = {
    minSetpointDeadBand: t.minSetpointDeadBand as number | undefined,
    minHeatSetpointLimit: t.minHeatSetpointLimit as number,
    maxHeatSetpointLimit: t.maxHeatSetpointLimit as number,
    minCoolSetpointLimit: t.minCoolSetpointLimit as number,
    maxCoolSetpointLimit: t.maxCoolSetpointLimit as number,
    occupiedHeatingSetpoint: t.occupiedHeatingSetpoint as number,
    occupiedCoolingSetpoint: t.occupiedCoolingSetpoint as number,
  };
  await server.close().catch(() => {});
  return snap;
}

// heat_cool plus explicit heat and cool builds the Heating+Cooling+AutoMode base,
// the only feature set where minSetpointDeadBand exists.
const autoCapable = {
  hvac_modes: ["off", "heat", "cool", "heat_cool"],
  min_temp: 7,
  max_temp: 30,
  current_temperature: 19,
  target_temp_low: 18,
  target_temp_high: 24,
  supported_features: 2,
};

describe("autoMode thermostat clears a stored deadband (#435)", () => {
  it("resets a stored 2°C deadband to 0 on mount", async () => {
    const t = await bringOnline("heat_cool", autoCapable, {
      minSetpointDeadBand: 20,
    });
    expect(t.minSetpointDeadBand).toBe(0);
  });

  it("keeps HA min/max as the setpoint limits, unshifted by the deadband", async () => {
    const t = await bringOnline("heat_cool", autoCapable, {
      minSetpointDeadBand: 20,
    });
    // 7°C / 30°C from HA, identical for both scopes. matter.js only shifts
    // limits for the deadband on controller writes, so this passes even
    // without the reset. Guard against future limit reconciliation changes.
    expect(t.minHeatSetpointLimit).toBe(700);
    expect(t.minCoolSetpointLimit).toBe(700);
    expect(t.maxHeatSetpointLimit).toBe(3000);
    expect(t.maxCoolSetpointLimit).toBe(3000);
  });

  it("lets heat and cool setpoints sit closer than 2°C", async () => {
    const t = await bringOnline(
      "heat_cool",
      { ...autoCapable, target_temp_low: 21, target_temp_high: 21 },
      { minSetpointDeadBand: 20 },
    );
    expect(t.minSetpointDeadBand).toBe(0);
    expect(t.occupiedHeatingSetpoint).toBe(2100);
    expect(t.occupiedCoolingSetpoint).toBe(2100);
  });

  it("starts at 0 with nothing stored", async () => {
    const t = await bringOnline("heat_cool", autoCapable, {});
    expect(t.minSetpointDeadBand).toBe(0);
  });

  // The real persisted path: matter.js keeps one file per attribute. Drop in
  // the 2°C default between mounts, the way a store written by an old build
  // holds it, and the remount has to come up with 0 and rewrite the file.
  it("heals a poisoned store file back to 0 on remount", async () => {
    await bringOnline("heat_cool", autoCapable, {});
    const prefix = join(
      dir,
      "climate435-node",
      "root.parts.aggregator.parts.rad.thermostat",
    );
    // sibling attribute pins the layout, the deadband file itself only
    // exists once a build persisted a non-default value
    expect(existsSync(`${prefix}.systemMode`)).toBe(true);
    const file = `${prefix}.minSetpointDeadBand`;
    writeFileSync(file, "20");

    const t = await bringOnline("heat_cool", autoCapable, {});
    expect(t.minSetpointDeadBand).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("0");
  });
});
