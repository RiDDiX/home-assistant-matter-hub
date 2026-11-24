import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BridgeData,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, Logger, VariableService } from "@matter/general";
import type { Endpoint } from "@matter/main";
import { DeviceTypeConformanceService } from "@matter/main/node";
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

// Server mode devices sit under the root, not an Aggregator, so same type
// siblings need a Descriptor TagList (Base device type, Duplicate condition).

type Attrs = Record<string, unknown>;

function haRegistry(
  entities: [string, string, Attrs][],
): HomeAssistantRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: registry stub
  const reg: Record<string, any> = {};
  const states: Record<string, HomeAssistantEntityState> = {};
  for (const [id, state, attrs] of entities) {
    reg[id] = { entity_id: id, device_id: "dev1", unique_id: id };
    states[id] = {
      entity_id: id,
      state,
      attributes: { friendly_name: id, ...attrs },
      context: { id: "c" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
      // biome-ignore lint/suspicious/noExplicitAny: fixture
    } as any;
  }
  return {
    entities: reg,
    states,
    devices: {
      dev1: { id: "dev1", name: "Dev", manufacturer: "t", model: "m" },
    },
    labels: [],
    areas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: registry stub
  } as any;
}

const bridgeData = {
  id: "sm",
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

let dir: string;
let env: Environment;
let node: ServerModeServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-sm-tags-"));
  env = new Environment("sm-tags", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call() {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await node?.close().catch(() => {});
  node = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function tagOf(endpoint: Endpoint) {
  // biome-ignore lint/suspicious/noExplicitAny: read descriptor state
  return (endpoint.state as any).descriptor.tagList?.map(
    (t: { namespaceId: number; tag: number }) => [t.namespaceId, t.tag],
  );
}

describe("server mode duplicate TagList (#301)", () => {
  it("numbers same type devices of a server mode node", async () => {
    const ha = haRegistry([
      // pause, stop, return home, state, start
      [
        "vacuum.smm",
        "docked",
        { supported_features: 4 | 8 | 16 | 4096 | 8192 },
      ],
      ["switch.smm_b", "off", {}],
      ["switch.smm_a", "on", {}],
    ]);
    const data = new BridgeDataProvider(bridgeData);
    env.set(BridgeDataProvider, data);
    env.set(EntityStateProvider, new EntityStateProvider(ha));
    const registry = new BridgeRegistry(ha, data);
    node = new ServerModeServerNode(env, bridgeData);
    await node.construction.ready;
    const manager = new ServerModeEndpointManager(
      node,
      {
        connection: {},
        haRunning: true,
        runningSince: 0,
      } as unknown as HomeAssistantClient,
      registry,
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
      Logger.get("sm-tags"),
    );
    await manager.refreshDevices();

    expect(manager.failedEntities).toEqual([]);
    expect(manager.devices.map((d) => [d.id, tagOf(d)]).sort()).toEqual([
      ["switch_smm_a", [[7, 1]]],
      ["switch_smm_b", [[7, 2]]],
      ["vacuum_smm", undefined],
    ]);
    const verdict = node.env
      .get(DeviceTypeConformanceService)
      .validateNodeScope(node, { refuse: false });
    const tagList = [...verdict].flatMap(([, list]) =>
      list.filter((v) => v.requirement.includes("TAGLIST")),
    );
    expect(tagList).toEqual([]);
    manager.stopObserving();
  });
});
