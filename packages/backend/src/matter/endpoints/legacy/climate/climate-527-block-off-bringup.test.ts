import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { Write } from "@matter/main/protocol";
import { StatusCode } from "@matter/main/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import type { HomeAssistantRegistry } from "../../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #527: Apple Home always shows a power button on thermostats. A Wiser room
// (auto = schedule, heat = manual, off = frost protection) lost its schedule
// on every tap. climateBlockOff answers Off with ConstraintError and skips the
// OnOff cluster, so the tap never reaches HA.

const DEVICE = "wiser-dev";
let CLIMATE = "climate.wiser";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let controller: ServerNode | undefined;
let calls: HomeAssistantAction[] = [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wiserState(value: string): HomeAssistantEntityState {
  return {
    entity_id: CLIMATE,
    state: value,
    attributes: {
      friendly_name: "Lounge",
      hvac_modes: ["auto", "heat", "off"],
      hvac_action: "idle",
      min_temp: 5,
      max_temp: 30,
      temperature: 20,
      current_temperature: 19.5,
      // TARGET_TEMPERATURE | PRESET_MODE | TURN_OFF | TURN_ON
      supported_features: 401,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  } as unknown as HomeAssistantEntityState;
}

function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
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
  } as any);
}

function registry(value: string): BridgeRegistry {
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Lounge" } },
    entities: {
      [CLIMATE]: {
        area_id: null,
        categories: {},
        device_id: DEVICE,
        disabled_by: null,
        entity_category: null,
        entity_id: CLIMATE,
        has_entity_name: false,
        hidden_by: null,
        id: CLIMATE,
        labels: [],
        name: null,
        original_name: CLIMATE,
        platform: "test",
        translation_key: null,
        unique_id: CLIMATE,
      } as unknown as HomeAssistantEntityRegistry,
    },
    labels: [],
    states: { [CLIMATE]: wiserState(value) },
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-527climate-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
    fireEvent() {},
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
  await controller?.close().catch(() => {});
  controller = undefined;
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(value: string, mapping?: Partial<EntityMappingConfig>) {
  CLIMATE = `climate.wiser${counter}`;
  const endpoint = await LegacyEndpoint.create(registry(value), CLIMATE, {
    entityId: CLIMATE,
    ...mapping,
  });
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `527climate-node-${counter}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint!);
  await server.start();
  // biome-ignore lint/suspicious/noExplicitAny: runtime state
  const port = (server.state as any).network.operationalPort as number;

  controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: `527climate-controller-${counter++}`,
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  await controller.start();
  const client = await controller.peers.forDescriptor({
    addresses: [{ type: "udp", ip: "127.0.0.1", port }],
    deviceIdentifier: `527-${counter}`,
    D: 3840,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
  await client.commission({
    passcode: 20202021,
    discriminator: 3840,
    autoSubscribe: false,
    autoStateInitialize: false,
  });
  return { endpoint: endpoint!, client };
}

// Returns the attribute status the controller sees.
async function remoteWrite(
  // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  client: any,
  endpointNo: number,
  name: string,
  value: number,
): Promise<number | undefined> {
  const result = await client.interaction.write(
    Write(
      Write.Attribute({
        endpoint: endpointNo,
        cluster: Thermostat,
        attributes: name,
        value,
        // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
      } as any),
    ),
  );
  return result[0]?.status;
}

const thermostat = (endpoint: LegacyEndpoint) =>
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  (endpoint.state as any).thermostat;
const modeCalls = () =>
  calls.filter((c) => c.action === "climate.set_hvac_mode");

describe("climateBlockOff (#527)", { timeout: 30_000 }, () => {
  it("refuses Off and Sleep from a controller and keeps the schedule", async () => {
    const { endpoint, client } = await mount("auto", { climateBlockOff: true });
    expect(Object.keys(endpoint.behaviors.supported)).not.toContain("onOff");
    expect(thermostat(endpoint).systemMode).toBe(Thermostat.SystemMode.Heat);
    calls = [];

    for (const mode of [
      Thermostat.SystemMode.Off,
      Thermostat.SystemMode.Sleep,
    ]) {
      expect(
        await remoteWrite(client, endpoint.number, "systemMode", mode),
      ).toBe(StatusCode.ConstraintError);
    }
    expect(calls).toEqual([]);
    expect(thermostat(endpoint).systemMode).toBe(Thermostat.SystemMode.Heat);

    // Temperature changes still go through.
    expect(
      await remoteWrite(
        client,
        endpoint.number,
        "occupiedHeatingSetpoint",
        2150,
      ),
    ).toBe(StatusCode.Success);
    expect(calls.map((c) => c.action)).toEqual(["climate.set_temperature"]);
  });

  it("still shows an Off set in HA and lets the controller turn it back on", async () => {
    const { endpoint, client } = await mount("auto", { climateBlockOff: true });
    await endpoint.updateStates({ [CLIMATE]: wiserState("off") });
    await delay(150);
    expect(thermostat(endpoint).systemMode).toBe(Thermostat.SystemMode.Off);

    calls = [];
    expect(
      await remoteWrite(
        client,
        endpoint.number,
        "systemMode",
        Thermostat.SystemMode.Heat,
      ),
    ).toBe(StatusCode.Success);
    expect(modeCalls()).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: action payload
    expect((modeCalls()[0].data as any).hvac_mode).toBe("heat");
  });

  it("forwards Off without the option", async () => {
    const { endpoint, client } = await mount("auto");
    calls = [];
    expect(
      await remoteWrite(
        client,
        endpoint.number,
        "systemMode",
        Thermostat.SystemMode.Off,
      ),
    ).toBe(StatusCode.Success);
    expect(modeCalls()).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: action payload
    expect((modeCalls()[0].data as any).hvac_mode).toBe("off");
  });
});
