import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { Write } from "@matter/main/protocol";
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
import { ServerModeServerNode } from "../../server-mode-server-node.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// Two server-mode bridges exposing the same climate entity. The nudge and
// auto-resume state of one thermostat must never leak into the other, it was
// keyed by entity id once and is per endpoint now.

const DEVICE = "shared-dev";
const CLIMATE = "climate.shared";
const HVAC_MODES = ["off", "heat", "cool", "heat_cool"];

let dir: string;
let counter = 0;
const nodes: ServerNode[] = [];

interface Side {
  // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  client: any;
  endpoint: LegacyEndpoint;
  calls: HomeAssistantAction[];
  failTemperature: boolean;
}

function climateState(): HomeAssistantEntityState {
  const attributes: Record<string, unknown> = {
    friendly_name: "Shared",
    hvac_modes: HVAC_MODES,
    min_temp: 7,
    max_temp: 35,
    temperature: 21,
    current_temperature: 22,
    // TARGET_TEMPERATURE | TURN_OFF | TURN_ON
    supported_features: 385,
  };
  return {
    entity_id: CLIMATE,
    state: "off",
    attributes,
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function bridgeData(id: string, appleAdaptiveTemperature: boolean) {
  return {
    id,
    name: id,
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: { serverMode: true, appleAdaptiveTemperature },
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "t",
      productId: 0x8000,
      productName: "t",
      productLabel: "t",
      hardwareVersion: 1,
      softwareVersion: 1,
    },
  } as ConstructorParameters<typeof BridgeDataProvider>[0];
}

async function mountSide(appleAdaptiveTemperature: boolean): Promise<Side> {
  const id = `shared-${counter++}`;
  const env = new Environment(id, Environment.default);
  env.get(VariableService).set("storage.path", dir);
  const data = bridgeData(id, appleAdaptiveTemperature);
  const dataProvider = new BridgeDataProvider(data);
  env.set(BridgeDataProvider, dataProvider);
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
  } as unknown as HomeAssistantConfig);
  const side = { calls: [], failTemperature: false } as unknown as Side;
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      if (side.failTemperature && action.action === "climate.set_temperature") {
        side.failTemperature = false;
        throw new Error("set_temperature failed");
      }
      side.calls.push(action);
    },
    fireEvent() {},
  } as unknown as HomeAssistantActions);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
  } as unknown as EntityStateProvider);

  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Shared" } },
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
    states: { [CLIMATE]: climateState() },
  } as unknown as HomeAssistantRegistry;
  const endpoint = await LegacyEndpoint.create(
    new BridgeRegistry(haRegistry, dataProvider),
    CLIMATE,
    undefined,
    undefined,
    true,
  );
  expect(endpoint).toBeDefined();
  side.endpoint = endpoint!;

  const server = new ServerModeServerNode(env, data as never);
  nodes.push(server);
  await server.construction;
  await server.addDevice(endpoint!);
  await server.start();
  // biome-ignore lint/suspicious/noExplicitAny: runtime state
  const state = server.state as any;

  const controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      environment: env,
      id: `${id}-controller`,
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  nodes.push(controller);
  await controller.start();
  side.client = await controller.peers.forDescriptor({
    addresses: [
      { type: "udp", ip: "127.0.0.1", port: state.network.operationalPort },
    ],
    deviceIdentifier: id,
    D: state.commissioning.discriminator,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
  await side.client.commission({
    passcode: state.commissioning.passcode,
    discriminator: state.commissioning.discriminator,
    autoSubscribe: false,
    autoStateInitialize: false,
  });
  side.calls = [];
  return side;
}

async function remoteWrite(side: Side, attrs: Record<string, number>) {
  await side.client.interaction.write(
    Write(
      ...Object.entries(attrs).map(([name, value]) =>
        Write.Attribute({
          endpoint: side.endpoint.number,
          cluster: Thermostat,
          attributes: name,
          value,
          // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
        } as any),
      ),
    ),
  );
}

const systemMode = (side: Side) =>
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  (side.endpoint.state as any).thermostat.systemMode;
const modeCalls = (side: Side) =>
  side.calls.filter((c) => c.action === "climate.set_hvac_mode");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-shared-climate-"));
});

afterEach(async () => {
  for (const node of nodes.reverse()) {
    await node.close().catch(() => {});
  }
  nodes.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe.each([
  false,
  true,
])("same climate entity on two bridges, adaptive=%s", (adaptive) => {
  it(
    "resumes each thermostat from Off on its own",
    {
      timeout: 60_000,
    },
    async () => {
      const a = await mountSide(adaptive);
      const b = await mountSide(adaptive);

      await remoteWrite(a, { occupiedCoolingSetpoint: 2000 });
      expect(modeCalls(a).map((c) => c.data)).toEqual([{ hvac_mode: "cool" }]);
      expect(systemMode(a)).toBe(Thermostat.SystemMode.Cool);
      expect(b.calls).toEqual([]);
      expect(systemMode(b)).toBe(Thermostat.SystemMode.Off);

      await remoteWrite(b, { occupiedCoolingSetpoint: 2000 });
      expect(modeCalls(b).map((c) => c.data)).toEqual([{ hvac_mode: "cool" }]);
      expect(systemMode(b)).toBe(Thermostat.SystemMode.Cool);
      expect(modeCalls(a)).toHaveLength(1);
    },
  );

  it(
    "a pending resume on one bridge never swallows a mode write on the other",
    {
      timeout: 60_000,
    },
    async () => {
      const a = await mountSide(adaptive);
      const b = await mountSide(adaptive);

      // the write aborts after the resume, A keeps an unconsumed Cool entry
      a.failTemperature = true;
      await remoteWrite(a, { occupiedCoolingSetpoint: 2000 }).catch(() => {});
      expect(a.failTemperature).toBe(false);
      expect(systemMode(a)).toBe(Thermostat.SystemMode.Off);

      await remoteWrite(b, { systemMode: Thermostat.SystemMode.Cool });
      expect(modeCalls(b).map((c) => c.data)).toEqual([{ hvac_mode: "cool" }]);
    },
  );
});
