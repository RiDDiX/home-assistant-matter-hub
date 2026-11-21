import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BridgeData,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, Logger, VariableService } from "@matter/general";
import { ServerNodeStore } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { HomeAssistantActions } from "../home-assistant/home-assistant-actions.js";
import type { HomeAssistantClient } from "../home-assistant/home-assistant-client.js";
import { HomeAssistantConfig } from "../home-assistant/home-assistant-config.js";
import type { HomeAssistantRegistry } from "../home-assistant/home-assistant-registry.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";
import { ServerModeEndpointManager } from "./server-mode-endpoint-manager.js";

// Server mode devices are direct children of the root node, so the root
// PartsList moves with them and ConfigurationVersion has to follow (#505).

const bridgeData = {
  id: "sm-cv",
  name: "sm",
  port: 0,
  filter: { include: [], exclude: [], includeMode: "any" },
  featureFlags: {},
  basicInformation: {
    vendorId: 0xfff1,
    vendorName: "t",
    productId: 0x8000,
    productName: "t",
    productLabel: "t",
    hardwareVersion: 1,
    softwareVersion: 1,
  },
} as unknown as BridgeData;

function haRegistry(ids: string[]): HomeAssistantRegistry {
  const ha = {
    entities: {},
    states: {},
    devices: {},
    labels: [],
    areas: new Map(),
  } as unknown as HomeAssistantRegistry;
  for (const id of ids) addSwitch(ha, id);
  return ha;
}

function addSwitch(ha: HomeAssistantRegistry, id: string) {
  ha.entities[id] = { entity_id: id, unique_id: id } as never;
  ha.states[id] = {
    entity_id: id,
    state: "on",
    attributes: { friendly_name: id },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  } as HomeAssistantEntityState;
}

let dir: string;
let node: ServerModeServerNode | undefined;
let manager: ServerModeEndpointManager | undefined;

// One node process: same storage dir and node id across restarts.
async function start(ha: HomeAssistantRegistry) {
  const env = new Environment("sm-cv", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call() {},
    fireEvent() {},
  } as unknown as HomeAssistantActions);
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
  } as unknown as HomeAssistantConfig);
  const data = new BridgeDataProvider(bridgeData);
  env.set(BridgeDataProvider, data);
  env.set(EntityStateProvider, new EntityStateProvider(ha));
  node = new ServerModeServerNode(env, bridgeData);
  await node.construction.ready;
  manager = new ServerModeEndpointManager(
    node,
    {
      connection: {},
      haRunning: true,
      runningSince: 0,
    } as unknown as HomeAssistantClient,
    new BridgeRegistry(ha, data),
    {
      getMapping: () => undefined,
      getMappingsForBridge: () => [],
      markMappingMissing() {},
      clearMappingMissing() {},
    } as unknown as EntityMappingStorage,
    {
      getIdentity: () => undefined,
      getBridgeIdentities: () => new Map(),
      setIdentity() {},
      markIdentityMissing() {},
      clearIdentityMissing() {},
    } as unknown as EntityIdentityStorage,
    data,
    Logger.get("sm-cv"),
  );
  await manager.refreshDevices();
  return manager;
}

async function stop() {
  manager?.stopObserving();
  await node?.close().catch(() => {});
  manager = undefined;
  node = undefined;
}

// Runs the armed settle compare now instead of after the settle delay.
async function settle(m: ServerModeEndpointManager) {
  const t = (
    m as unknown as {
      topology: {
        timer?: ReturnType<typeof setTimeout>;
        enqueue(run: () => Promise<unknown>): Promise<void>;
        compare(): Promise<void>;
      };
    }
  ).topology;
  if (t.timer === undefined) return;
  clearTimeout(t.timer);
  t.timer = undefined;
  await t.enqueue(() => t.compare());
}

const version = () =>
  node!.stateOf(BasicInformationServer).configurationVersion;

const stored = () =>
  node!.env
    .get(ServerNodeStore)
    .storage.createContext("hamh")
    .get<string>("topology", "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-sm-cv-"));
});

afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("server mode ConfigurationVersion follows the device set", () => {
  it("stores the first set without bumping", async () => {
    const m = await start(haRegistry(["switch.a"]));
    expect(await stored()).toBe("");
    await settle(m);
    expect(version()).toBe(1);
    expect(await stored()).toMatch(/^v2:/);
  });

  it("bumps once for a device added after the first settle", async () => {
    const ha = haRegistry(["switch.a"]);
    const m = await start(ha);
    await settle(m);
    addSwitch(ha, "switch.b");
    await m.refreshDevices();
    expect(m.devices).toHaveLength(2);
    expect(version()).toBe(1);
    await settle(m);
    expect(version()).toBe(2);
    await m.refreshDevices();
    await settle(m);
    expect(version()).toBe(2);
  });

  it("stays put across a restart with the same set", async () => {
    const ha = haRegistry(["switch.a"]);
    const m = await start(ha);
    await settle(m);
    addSwitch(ha, "switch.b");
    await m.refreshDevices();
    await settle(m);
    expect(version()).toBe(2);
    await stop();

    const restarted = await start(ha);
    expect(restarted.devices).toHaveLength(2);
    await settle(restarted);
    expect(version()).toBe(2);
  });
});
