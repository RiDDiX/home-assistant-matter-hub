import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityMappingConfig,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../home-assistant/home-assistant-actions.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";

// The root ConfigurationVersion has to move once whenever the set of bridged
// endpoints changes, HA entities included, and never for a restart that
// brings back the same set (Matter 1.6, #505).

const BRIDGE_ID = "bridge-cv";

class FakeIdentityStorage {
  // biome-ignore lint/suspicious/noExplicitAny: minimal record store
  private m = new Map<string, Map<string, any>>();
  getIdentity(b: string, k: string) {
    return this.m.get(b)?.get(k);
  }
  getBridgeIdentities(b: string) {
    return this.m.get(b) ?? new Map();
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal record store
  setIdentity(b: string, k: string, r: any) {
    let bm = this.m.get(b);
    if (!bm) {
      bm = new Map();
      this.m.set(b, bm);
    }
    bm.set(k, r);
  }
  markIdentityMissing() {}
  clearIdentityMissing() {}
  async deleteIdentity(b: string, k: string) {
    this.m.get(b)?.delete(k);
  }
  async deleteBridgeIdentities(b: string) {
    this.m.delete(b);
  }
}

class FakeMappingStorage {
  private m = new Map<string, Map<string, EntityMappingConfig>>();
  getMapping(b: string, e: string) {
    return this.m.get(b)?.get(e);
  }
  getMappingsForBridge(b: string) {
    return [...(this.m.get(b)?.values() ?? [])];
  }
  markMappingMissing() {}
  clearMappingMissing() {}
  async deleteMapping(b: string, e: string) {
    this.m.get(b)?.delete(e);
  }
  async deleteBridgeMappings(b: string) {
    this.m.delete(b);
  }
}

interface FakeHa {
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  entities: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  states: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  devices: Record<string, any>;
  areas: Map<string, string>;
  labels: unknown[];
  snapshotGeneration: number;
}

function addEntity(ha: FakeHa, id: string) {
  ha.entities[id] = { entity_id: id };
  ha.states[id] = {
    entity_id: id,
    state: "docked",
    attributes: { friendly_name: id, supported_features: 4 },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function makeHa(ids: string[]): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
  };
  for (const id of ids) addEntity(ha, id);
  return ha;
}

function makeProvider(patterns: string[]): BridgeDataProvider {
  return new BridgeDataProvider({
    id: BRIDGE_ID,
    name: "b",
    port: 0,
    filter: {
      include: patterns.map((value) => ({
        type: HomeAssistantMatcherType.Pattern,
        value,
      })),
      exclude: [],
      includeMode: "any",
    },
    featureFlags: {},
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

let dir: string;
let server: ServerNode | undefined;
let manager: BridgeEndpointManager | undefined;

// One bridge process: same storage dir and node id across restarts.
async function startBridge(ha: FakeHa, patterns = ["vacuum.*"]) {
  const provider = makeProvider(patterns);
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, provider);
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const node = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "bem-cv-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  server = node;
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  const registry = new BridgeRegistry(ha as any, provider);
  const client = { connection: {}, haRunning: true, runningSince: 0 };
  const bem = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    client as any,
    registry,
    new FakeMappingStorage() as unknown as EntityMappingStorage,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider.id,
    {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  );
  manager = bem;
  await node.add(bem.root);
  // same handler as bridge.ts
  bem.setTopologyChangeHandler(async (change) => {
    await node.act("topology change", (agent) =>
      agent.get(BasicInformationServer).increaseConfigurationVersion(change),
    );
  });
  // bridge.ts start order: reconcile, then the plugin start
  await bem.refreshDevices();
  await bem.startPlugins();
  return { bem, provider };
}

async function stopBridge() {
  await manager?.stopPlugins();
  manager?.stopObserving();
  await manager?.dispose().catch(() => {});
  await server?.close().catch(() => {});
  manager = undefined;
  server = undefined;
}

const version = () =>
  server!.stateOf(BasicInformationServer).configurationVersion;

// Runs the armed settle compare now instead of after TOPOLOGY_SETTLE_MS.
async function settle(bem: BridgeEndpointManager) {
  const t = bem as unknown as {
    topologyTimer?: ReturnType<typeof setTimeout>;
    enqueueTopology(run: () => Promise<unknown>): Promise<void>;
    compareTopology(): Promise<void>;
  };
  if (t.topologyTimer === undefined) return;
  clearTimeout(t.topologyTimer);
  t.topologyTimer = undefined;
  await t.enqueueTopology(() => t.compareTopology());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bem-cv-"));
});

afterEach(async () => {
  await stopBridge();
  rmSync(dir, { recursive: true, force: true });
});

describe("root ConfigurationVersion follows the bridged endpoint set", () => {
  it("stores the first set without bumping", async () => {
    const { bem } = await startBridge(makeHa(["vacuum.a"]));
    await settle(bem);
    expect(version()).toBe(1);
  });

  it("bumps once for an HA endpoint added at runtime", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    await settle(bem);
    expect(bem.root.parts.size).toBe(2);
    expect(version()).toBe(2);
  });

  it("bumps once for an HA endpoint removed", async () => {
    const { bem, provider } = await startBridge(
      makeHa(["vacuum.a", "vacuum.b"]),
    );
    await settle(bem);
    provider.update({
      id: BRIDGE_ID,
      filter: {
        include: [
          { type: HomeAssistantMatcherType.Pattern, value: "vacuum.a" },
        ],
        exclude: [],
        includeMode: "any",
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial update is enough
    } as any);
    await bem.refreshDevices();
    await settle(bem);
    expect(bem.root.parts.size).toBe(1);
    expect(version()).toBe(2);
  });

  it("bumps once for two adds in one reconcile", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    addEntity(ha, "vacuum.b");
    addEntity(ha, "vacuum.c");
    await bem.refreshDevices();
    await settle(bem);
    expect(bem.root.parts.size).toBe(3);
    expect(version()).toBe(2);
  });

  it("bumps once for two separate changes inside one settle window", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    addEntity(ha, "vacuum.c");
    await bem.refreshDevices();
    expect(version()).toBe(1);
    await settle(bem);
    expect(bem.root.parts.size).toBe(3);
    expect(version()).toBe(2);
  });

  it("bumps once for a set change the reconcile itself did not make", async () => {
    const ha = makeHa(["vacuum.a", "vacuum.b"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    // isolation closes the endpoint between reconciles, and without a state
    // the next reconcile cannot bring it back
    await bem.isolateEntity("vacuum.b");
    delete ha.states["vacuum.b"];
    await bem.refreshDevices();
    expect(bem.root.parts.size).toBe(1);
    await settle(bem);
    expect(version()).toBe(2);
  });

  it("stays put when a reconcile changes nothing", async () => {
    const { bem } = await startBridge(makeHa(["vacuum.a"]));
    await settle(bem);
    await bem.refreshDevices();
    await bem.refreshDevices();
    await settle(bem);
    expect(version()).toBe(1);
  });

  it("stays put across a restart with the same set", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    await settle(bem);
    expect(version()).toBe(2);
    await stopBridge();

    const restarted = await startBridge(ha);
    await settle(restarted.bem);
    expect(version()).toBe(2);
  });

  it("stays put when a start passes through a partial set", async () => {
    const ha = makeHa(["vacuum.a", "vacuum.b"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    await stopBridge();

    // vacuum.b has no state yet after a reboot, it mounts a tick later
    const late = ha.states["vacuum.b"];
    delete ha.states["vacuum.b"];
    const restarted = await startBridge(ha);
    expect(restarted.bem.root.parts.size).toBe(1);
    ha.states["vacuum.b"] = late;
    await restarted.bem.refreshDevices();
    expect(restarted.bem.root.parts.size).toBe(2);
    await settle(restarted.bem);
    expect(version()).toBe(1);
  });

  it("bumps once across a restart with a changed set", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    expect(version()).toBe(1);
    await stopBridge();

    addEntity(ha, "vacuum.b");
    addEntity(ha, "vacuum.c");
    const restarted = await startBridge(ha);
    await settle(restarted.bem);
    expect(restarted.bem.root.parts.size).toBe(3);
    expect(version()).toBe(2);
    await restarted.bem.refreshDevices();
    await settle(restarted.bem);
    expect(version()).toBe(2);
  });

  it("keeps a change that was still settling when the bridge stopped", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    await stopBridge();

    const restarted = await startBridge(ha);
    await settle(restarted.bem);
    expect(version()).toBe(2);
  });
});
