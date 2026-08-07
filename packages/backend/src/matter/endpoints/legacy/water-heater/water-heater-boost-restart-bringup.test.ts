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
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

// Review follow-ups on the Matter 1.4 water heater (#437):
// - a persisted currentMode must not brick the endpoint when the mode left
//   operation_list between restarts (currentMode has quality N and overrides
//   the seeded default before the mode server's own update runs),
// - Boost must survive the HA state event that still carries the pre-boost
//   operation mode (set_operation_mode confirms asynchronously),
// - a boost has to survive a bridge restart instead of stranding HA in
//   high_demand, and an external cancel still has to give the temporary
//   setpoint back.

let dir: string;
let counter = 0;
let server: ServerNode | undefined;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-water-heater-437-"));
  calls = [];
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function makeEnv(): Environment {
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
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
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  return env;
}

function waterHeater(
  state: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const entityId = "water_heater.boiler";
  return {
    entity_id: entityId,
    state: {
      entity_id: entityId,
      state,
      attributes: { friendly_name: "Boiler", ...attributes },
      context: { id: "c" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: `2026-01-01T00:00:0${counter % 10}.${counter}`,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
  };
}

async function bringUp(entity: HomeAssistantEntityInformation, nodeId: string) {
  const type = createLegacyEndpointType(entity, {
    entityId: entity.entity_id,
    matterDeviceType: "water_heater_management",
  });
  if (!type) {
    throw new Error("no endpoint type");
  }
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: makeEnv() as any,
    id: nodeId,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "water-heater" });
  await aggregator.add(endpoint);
  return endpoint;
}

async function remount(entity: HomeAssistantEntityInformation, nodeId: string) {
  await server?.close();
  server = undefined;
  return await bringUp(entity, nodeId);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Push a fresh HA state the way the bridge does, through entity$Changed.
async function drive(
  endpoint: Endpoint,
  state: string,
  attributes: Record<string, unknown>,
) {
  counter++;
  await endpoint.setStateOf(HomeAssistantEntityBehavior, {
    entity: waterHeater(state, attributes),
  });
  await delay(30);
}

// biome-ignore lint/suspicious/noExplicitAny: reads cluster state off the agent
async function boostState(endpoint: Endpoint<any>): Promise<number> {
  let result: number | undefined;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    result = Number((agent as any).waterHeaterManagement.state.boostState);
  });
  if (result === undefined) throw new Error("boostState not read");
  return result;
}

// biome-ignore lint/suspicious/noExplicitAny: reads cluster state off the agent
async function modeState(endpoint: Endpoint<any>) {
  let result:
    | { currentMode: number; supported: { mode: number; label: string }[] }
    | undefined;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const mode = (agent as any).waterHeaterMode.state;
    result = {
      currentMode: Number(mode.currentMode),
      supported: (mode.supportedModes as { mode: number; label: string }[]).map(
        (m) => ({ mode: Number(m.mode), label: m.label }),
      ),
    };
  });
  if (!result) throw new Error("mode state not read");
  return result;
}

// biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
async function boost(endpoint: Endpoint<any>, info: Record<string, unknown>) {
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
    (agent as any).waterHeaterManagement.boost({ boostInfo: info });
  });
}

const FULL_HEATER = {
  operation_list: ["eco", "heat_pump", "high_demand", "off"],
  operation_mode: "eco",
  current_temperature: 45,
  temperature: 60,
  min_temp: 30,
  max_temp: 75,
};

describe("persisted currentMode vs a changed operation_list", () => {
  it("remounts after a mode left operation_list instead of bricking", async () => {
    const nodeId = "wh437-mode-node";
    const withGas = {
      ...FULL_HEATER,
      operation_list: ["eco", "gas", "high_demand", "off"],
    };
    const first = await bringUp(waterHeater("eco", withGas), nodeId);
    // A runtime change lands in storage: currentMode is quality N.
    await drive(first, "gas", { ...withGas, operation_mode: "gas" });
    expect((await modeState(first)).currentMode).toBe(3);

    // The integration dropped gas from operation_list before the restart.
    const second = await remount(
      waterHeater("eco", {
        ...FULL_HEATER,
        operation_list: ["eco", "high_demand", "off"],
        operation_mode: "eco",
      }),
      nodeId,
    );

    const mode = await modeState(second);
    expect(mode.supported.map((m) => m.mode)).not.toContain(3);
    expect(mode.supported.map((m) => m.mode)).toContain(mode.currentMode);
  });
});

describe("boost vs the async HA mode confirmation", () => {
  it("survives a state event that still carries the pre-boost mode", async () => {
    const endpoint = await bringUp(
      waterHeater("eco", FULL_HEATER),
      "wh437-race-node",
    );
    await boost(endpoint, { duration: 3600 });
    expect(await boostState(endpoint)).toBe(1); // Active

    // HA has not confirmed set_operation_mode yet, this event is stale.
    await drive(endpoint, "eco", { ...FULL_HEATER, operation_mode: "eco" });
    expect(await boostState(endpoint)).toBe(1); // still Active

    // Confirmation arrives, then the user cancels from the HA side.
    await drive(endpoint, "high_demand", {
      ...FULL_HEATER,
      operation_mode: "high_demand",
    });
    expect(await boostState(endpoint)).toBe(1);

    await drive(endpoint, "eco", { ...FULL_HEATER, operation_mode: "eco" });
    expect(await boostState(endpoint)).toBe(0); // external cancel still works
  });

  it("gives the temporary setpoint back on an external cancel", async () => {
    const endpoint = await bringUp(
      waterHeater("eco", FULL_HEATER),
      "wh437-extcancel-node",
    );
    await boost(endpoint, { duration: 3600, temporarySetpoint: 7000 });
    await drive(endpoint, "high_demand", {
      ...FULL_HEATER,
      operation_mode: "high_demand",
      temperature: 70,
    });

    calls.length = 0;
    await drive(endpoint, "eco", {
      ...FULL_HEATER,
      operation_mode: "eco",
      temperature: 70,
    });

    expect(await boostState(endpoint)).toBe(0);
    // The setpoint override was ours, HA only took back the mode.
    expect(calls).toContainEqual({
      action: "water_heater.set_temperature",
      data: { temperature: 60 },
    });
    expect(calls).not.toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "eco" },
    });
  });
});

describe("boost vs a bridge restart", () => {
  it("re-arms a running boost and can still restore after a restart", async () => {
    const nodeId = "wh437-rearm-node";
    const first = await bringUp(waterHeater("eco", FULL_HEATER), nodeId);
    await boost(first, { duration: 3600, temporarySetpoint: 7000 });
    await drive(first, "high_demand", {
      ...FULL_HEATER,
      operation_mode: "high_demand",
      temperature: 70,
    });

    calls.length = 0;
    const second = await remount(
      waterHeater("high_demand", {
        ...FULL_HEATER,
        operation_mode: "high_demand",
        temperature: 70,
      }),
      nodeId,
    );

    // Still within the boost window, so the boost keeps running.
    expect(await boostState(second)).toBe(1);
    expect(calls).toEqual([]);

    // And the restored session still knows what CancelBoost has to undo.
    await second.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
      (agent as any).waterHeaterManagement.cancelBoost();
    });
    expect(calls).toContainEqual({
      action: "water_heater.set_temperature",
      data: { temperature: 60 },
    });
    expect(calls).toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "eco" },
    });
    expect(await boostState(second)).toBe(0);
  });

  it("restores HA right away when a OneShot boost spanned the restart", async () => {
    const nodeId = "wh437-oneshot-node";
    const first = await bringUp(waterHeater("eco", FULL_HEATER), nodeId);
    await boost(first, {
      duration: 3600,
      oneShot: true,
      temporarySetpoint: 7000,
    });

    calls.length = 0;
    const second = await remount(
      waterHeater("high_demand", {
        ...FULL_HEATER,
        operation_mode: "high_demand",
        temperature: 70,
      }),
      nodeId,
    );

    // Whether the water got hot during the downtime is unknowable, so a
    // OneShot boost ends with the restart and HA gets its state back.
    expect(calls).toContainEqual({
      action: "water_heater.set_temperature",
      data: { temperature: 60 },
    });
    expect(calls).toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "eco" },
    });
    expect(await boostState(second)).toBe(0);
  });
});

describe("a rejected second boost", () => {
  it("keeps the first boost's timer and restore intact", async () => {
    const endpoint = await bringUp(
      waterHeater("eco", FULL_HEATER),
      "wh437-reject-node",
    );
    await boost(endpoint, { duration: 1, temporarySetpoint: 7000 });
    await drive(endpoint, "high_demand", {
      ...FULL_HEATER,
      operation_mode: "high_demand",
      temperature: 70,
    });
    expect(await boostState(endpoint)).toBe(1);

    // Both rejection paths: TankPercent-only fields and an out-of-range
    // setpoint. Neither may tear down the running boost.
    await expect(
      boost(endpoint, { duration: 3600, targetPercentage: 80 }),
    ).rejects.toThrow(/TankPercent/);
    await expect(
      boost(endpoint, { duration: 3600, temporarySetpoint: 9000 }),
    ).rejects.toThrow(/setpoint limits/);
    expect(await boostState(endpoint)).toBe(1);

    calls.length = 0;
    await delay(1500);

    // The original 1s boost still expires on its own timer, with the full
    // restore of setpoint and operation mode.
    expect(await boostState(endpoint)).toBe(0);
    expect(calls).toContainEqual({
      action: "water_heater.set_temperature",
      data: { temperature: 60 },
    });
    expect(calls).toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "eco" },
    });
  }, 15_000);
});

describe("capitalized operation modes", () => {
  it("maps Eco / High Demand onto the known mode values", async () => {
    const endpoint = await bringUp(
      waterHeater("Eco", {
        ...FULL_HEATER,
        operation_list: ["Eco", "Heat Pump", "High Demand", "Off"],
        operation_mode: "Eco",
      }),
      "wh437-casing-node",
    );

    const mode = await modeState(endpoint);
    expect(mode.currentMode).toBe(1); // eco
    expect(mode.supported).toContainEqual({ mode: 4, label: "Heat Pump" });
    expect(mode.supported).toContainEqual({ mode: 5, label: "High Demand" });

    calls.length = 0;
    await boost(endpoint, { duration: 600 });
    // Boost finds the fast mode and calls HA with the entity's own casing.
    expect(calls).toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "High Demand" },
    });
  });

  it("arms and cancels the boost when state updates report snake_case", async () => {
    const CASED = {
      ...FULL_HEATER,
      operation_list: ["Eco", "Heat Pump", "High Demand", "Off"],
      operation_mode: "Eco",
    };
    const endpoint = await bringUp(
      waterHeater("Eco", CASED),
      "wh437-casing-cancel-node",
    );
    await boost(endpoint, { duration: 3600 });
    expect(await boostState(endpoint)).toBe(1);

    // operation_list says "High Demand", the state machine reports the mode
    // in snake_case. The boost must still count this as observed.
    await drive(endpoint, "high_demand", {
      ...CASED,
      operation_mode: "high_demand",
    });
    expect(await boostState(endpoint)).toBe(1);

    // Once observed, a foreign mode is an external cancel.
    await drive(endpoint, "eco", { ...CASED, operation_mode: "eco" });
    expect(await boostState(endpoint)).toBe(0);
  });
});
