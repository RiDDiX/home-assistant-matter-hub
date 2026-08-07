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
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

// Matter 1.4 Water Heater (0x050F): WaterHeaterManagement + WaterHeaterMode +
// a heating-only Thermostat on one endpoint. The mandatory clusters brick the
// endpoint on mount unless they are seeded, and WaterHeaterMode additionally
// asserts its Off/Manual tag invariants during initialize(), so this brings the
// real endpoint online through createLegacyEndpointType.

const WATER_HEATER = 0x050f; // 1295
const BOOST_COMMAND = 0x00;
const CANCEL_BOOST_COMMAND = 0x01;

const OFF_MODE = 0;
const ECO_MODE = 1;
const HEAT_PUMP_MODE = 4;
const HIGH_DEMAND_MODE = 5;

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-water-heater-"));
  calls = [];
  env = new Environment("test", Environment.default);
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
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

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
      last_updated: "2026-01-01T00:00:00",
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
  };
}

async function bringUp(entity: HomeAssistantEntityInformation) {
  const type = createLegacyEndpointType(entity, {
    entityId: entity.entity_id,
    matterDeviceType: "water_heater_management",
  });
  if (!type) {
    throw new Error("no endpoint type");
  }
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `water-heater-node-${counter++}`,
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

interface Snapshot {
  deviceTypes: number[];
  acceptedCommands: number[];
  boostState: number;
  heaterTypes: Record<string, boolean>;
  heatDemand: Record<string, boolean>;
  currentMode: number;
  supportedModes: { mode: number; label: string; tags: number[] }[];
  heatingSetpoint: number;
}

// biome-ignore lint/suspicious/noExplicitAny: reads cluster state off the agent
async function snapshot(endpoint: Endpoint<any>): Promise<Snapshot> {
  let result: Snapshot | undefined;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const a = agent as any;
    result = {
      deviceTypes: (
        a.descriptor.state.deviceTypeList as { deviceType: number }[]
      ).map((d) => Number(d.deviceType)),
      acceptedCommands: (
        a.waterHeaterManagement.state.acceptedCommandList as number[]
      ).map((c) => Number(c)),
      boostState: Number(a.waterHeaterManagement.state.boostState),
      heaterTypes: { ...a.waterHeaterManagement.state.heaterTypes },
      heatDemand: { ...a.waterHeaterManagement.state.heatDemand },
      currentMode: Number(a.waterHeaterMode.state.currentMode),
      supportedModes: (
        a.waterHeaterMode.state.supportedModes as {
          mode: number;
          label: string;
          modeTags: { value: number }[];
        }[]
      ).map((m) => ({
        mode: Number(m.mode),
        label: m.label,
        tags: m.modeTags.map((t) => Number(t.value)),
      })),
      heatingSetpoint: Number(a.thermostat.state.occupiedHeatingSetpoint),
    };
  });
  if (!result) {
    throw new Error("snapshot not taken");
  }
  return result;
}

const OFF_TAG = 0x4000;
const MANUAL_TAG = 0x4001;
const LOW_ENERGY_TAG = 4;
const MAX_TAG = 7;

const FULL_HEATER = {
  operation_list: ["eco", "heat_pump", "high_demand", "off"],
  operation_mode: "eco",
  current_temperature: 45,
  temperature: 60,
  min_temp: 30,
  max_temp: 75,
};

describe("Matter 1.4 water heater bring-up", () => {
  it("mounts as WaterHeater (0x050F) with Boost and CancelBoost", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    const state = await snapshot(endpoint);

    expect(state.deviceTypes).toContain(WATER_HEATER);
    expect(state.acceptedCommands).toContain(BOOST_COMMAND);
    expect(state.acceptedCommands).toContain(CANCEL_BOOST_COMMAND);
    // Seeded, otherwise the mandatory attributes brick the endpoint on mount.
    expect(state.boostState).toBe(0); // Inactive
  });

  it("maps operation_list onto Off, Manual and descriptive modes", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    const state = await snapshot(endpoint);

    const byMode = Object.fromEntries(
      state.supportedModes.map((m) => [m.mode, m]),
    );
    expect(byMode[OFF_MODE].tags).toEqual([OFF_TAG]);
    // heat_pump outranks eco for the Manual tag: Manual means "heat to the
    // thermostat setpoint", which is a heat source, not an energy profile.
    expect(byMode[HEAT_PUMP_MODE].tags).toEqual([MANUAL_TAG]);
    expect(byMode[ECO_MODE].tags).toEqual([LOW_ENERGY_TAG]);
    expect(byMode[HIGH_DEMAND_MODE].tags).toEqual([MAX_TAG]);
    // Exactly one Off and one Manual, the matter.js server asserts this.
    expect(
      state.supportedModes.filter((m) => m.tags.includes(MANUAL_TAG)),
    ).toHaveLength(1);
    expect(state.currentMode).toBe(ECO_MODE);
  });

  it("keeps the thermostat setpoint and the water heater temperature range", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    const state = await snapshot(endpoint);
    expect(state.heatingSetpoint).toBe(6000); // 60°C
  });

  it("reports heat sources and demand from the operation modes", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    const state = await snapshot(endpoint);

    expect(state.heaterTypes.heatPump).toBe(true);
    // 45°C current below the 60°C target, so the heater is calling for heat.
    expect(Object.values(state.heatDemand)).toContain(true);
  });

  it("stands up an entity without operation modes on a synthetic On mode", async () => {
    const endpoint = await bringUp(
      waterHeater("on", { current_temperature: 50, temperature: 55 }),
    );
    const state = await snapshot(endpoint);

    expect(state.supportedModes.map((m) => m.tags)).toEqual([
      [OFF_TAG],
      [MANUAL_TAG],
    ]);
    expect(state.heaterTypes.other).toBe(true);
  });
});

describe("Matter 1.4 water heater boost", () => {
  it("switches to high_demand and reports BoostState Active", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    calls.length = 0;

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
      (agent as any).waterHeaterManagement.boost({
        boostInfo: { duration: 3600 },
      });
    });

    expect(calls).toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "high_demand" },
    });
    expect((await snapshot(endpoint)).boostState).toBe(1); // Active
  });

  it("applies a temporary setpoint and restores it on CancelBoost", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    calls.length = 0;

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
      (agent as any).waterHeaterManagement.boost({
        boostInfo: { duration: 1800, temporarySetpoint: 7000 },
      });
    });
    expect(calls).toContainEqual({
      action: "water_heater.set_temperature",
      data: { temperature: 70 },
    });

    calls.length = 0;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
      (agent as any).waterHeaterManagement.cancelBoost();
    });

    // The pre-boost setpoint and operation mode both come back.
    expect(calls).toContainEqual({
      action: "water_heater.set_temperature",
      data: { temperature: 60 },
    });
    expect(calls).toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "eco" },
    });
    expect((await snapshot(endpoint)).boostState).toBe(0); // Inactive
  });

  it("rejects TargetPercentage without the TankPercent feature", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    calls.length = 0;

    await expect(async () => {
      await endpoint.act((agent) => {
        // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
        (agent as any).waterHeaterManagement.boost({
          boostInfo: { duration: 600, targetPercentage: 80 },
        });
      });
    }).rejects.toThrow(/TankPercent/);

    // Rejected commands must not touch Home Assistant.
    expect(calls).toEqual([]);
    expect((await snapshot(endpoint)).boostState).toBe(0); // Inactive
  });

  it("rejects a TemporarySetpoint outside the heat setpoint limits", async () => {
    // FULL_HEATER advertises 30..75 °C, so 90 °C is out of range.
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    calls.length = 0;

    await expect(async () => {
      await endpoint.act((agent) => {
        // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
        (agent as any).waterHeaterManagement.boost({
          boostInfo: { duration: 600, temporarySetpoint: 9000 },
        });
      });
    }).rejects.toThrow(/TemporarySetpoint/);

    expect((await snapshot(endpoint)).boostState).toBe(0); // Inactive
  });

  it("falls back to turn_on when no fast operation mode is offered", async () => {
    const endpoint = await bringUp(
      waterHeater("on", { current_temperature: 50, temperature: 55 }),
    );
    calls.length = 0;

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
      (agent as any).waterHeaterManagement.boost({
        boostInfo: { duration: 600 },
      });
    });

    expect(calls).toContainEqual({
      action: "water_heater.turn_on",
      data: {},
    });
    expect((await snapshot(endpoint)).boostState).toBe(1); // Active
  });
});

describe("Matter 1.4 water heater mode changes", () => {
  it("drives the HA operation mode from ChangeToMode", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    calls.length = 0;

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
      (agent as any).waterHeaterMode.changeToMode({ newMode: HEAT_PUMP_MODE });
    });

    expect(calls).toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "heat_pump" },
    });
  });

  it("turns the heater off through the Off mode", async () => {
    const endpoint = await bringUp(waterHeater("eco", FULL_HEATER));
    calls.length = 0;

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: invoke the cluster command
      (agent as any).waterHeaterMode.changeToMode({ newMode: OFF_MODE });
    });

    expect(calls).toContainEqual({
      action: "water_heater.set_operation_mode",
      data: { operation_mode: "off" },
    });
  });
});
