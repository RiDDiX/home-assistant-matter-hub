import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityMappingConfig,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import {
  ControllerBehavior,
  Endpoint,
  EndpointNumber,
  ServerNodeStore,
  VendorId,
} from "@matter/main";
import {
  BasicInformationServer,
  BridgedDeviceBasicInformationServer,
  DescriptorServer,
} from "@matter/main/behaviors";
import {
  BasicInformation,
  BridgedDeviceBasicInformation,
  Descriptor,
} from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { Read, Subscribe } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "../../plugins/plugin-manager.js";
import type { MatterHubPlugin, PluginContext } from "../../plugins/types.js";
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
  set(b: string, mapping: EntityMappingConfig) {
    let bm = this.m.get(b);
    if (!bm) {
      bm = new Map();
      this.m.set(b, bm);
    }
    bm.set(mapping.entityId, mapping);
  }
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
let mappings: FakeMappingStorage;

// One bridge process: same storage dir and node id across restarts.
async function startBridge(
  ha: FakeHa,
  patterns = ["vacuum.*"],
  plugins?: PluginManager,
) {
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
    mappings as unknown as EntityMappingStorage,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider.id,
    {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    plugins,
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

// Runs one compare now, armed timer or not.
async function compare(bem: BridgeEndpointManager) {
  const t = bem as unknown as {
    enqueueTopology(run: () => Promise<unknown>): Promise<void>;
    compareTopology(): Promise<void>;
  };
  await t.enqueueTopology(() => t.compareTopology());
}

const settleArmed = (bem: BridgeEndpointManager) =>
  (bem as unknown as { topologyTimer?: unknown }).topologyTimer !== undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bem-cv-"));
  mappings = new FakeMappingStorage();
});

afterEach(async () => {
  vi.restoreAllMocks();
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

  it("bumps once for an endpoint rebuilt under its id with another device type", async () => {
    const ha = makeHa(["switch.a"]);
    const { bem } = await startBridge(ha, ["switch.*"]);
    await settle(bem);
    const before = [...bem.root.parts].map((p) => p.id);
    mappings.set(BRIDGE_ID, {
      entityId: "switch.a",
      matterDeviceType: "on_off_light",
    } as EntityMappingConfig);
    await bem.refreshDevices();
    expect([...bem.root.parts].map((p) => p.id)).toEqual(before);
    expect(version()).toBe(1);
    await settle(bem);
    expect(version()).toBe(2);
    await bem.refreshDevices();
    await settle(bem);
    expect(version()).toBe(2);
  });

  it("replaces a signature stored in the old format without bumping", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    await stopBridge();

    // the old format hashed the part ids only, no prefix
    const restarted = await startBridge(ha);
    const storage = restarted.bem.root.env
      .get(ServerNodeStore)
      .storage.createContext("hamh");
    await storage.set("topology", "0123456789abcdef");
    addEntity(ha, "vacuum.b");
    await restarted.bem.refreshDevices();
    await settle(restarted.bem);
    expect(version()).toBe(1);
    expect(await storage.get<string>("topology", "")).toMatch(/^v2:/);
    await stopBridge();

    const again = await startBridge(ha);
    await settle(again.bem);
    expect(version()).toBe(1);
  });

  it("survives a part whose Descriptor state cannot be read", async () => {
    // only the signature read throws, matter.js itself reads the state too
    const proto = BridgeEndpointManager.prototype as unknown as {
      topologySignature(): string;
    };
    const signature = proto.topologySignature;
    let inSignature = false;
    vi.spyOn(proto, "topologySignature").mockImplementation(function (
      this: BridgeEndpointManager,
    ) {
      inSignature = true;
      try {
        return signature.call(this);
      } finally {
        inSignature = false;
      }
    });
    const stateOf = Endpoint.prototype.stateOf;
    vi.spyOn(Endpoint.prototype, "stateOf").mockImplementation(function (
      this: Endpoint,
      ...args: Parameters<Endpoint["stateOf"]>
    ) {
      if (
        inSignature &&
        args[0] === DescriptorServer &&
        this.id === "vacuum_b"
      ) {
        throw new Error("not initialized");
      }
      return stateOf.apply(this, args);
    });
    const ha = makeHa(["vacuum.a", "vacuum.b"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    await expect(bem.refreshDevices()).resolves.toBe(true);
    expect(bem.root.parts.size).toBe(2);
    expect(version()).toBe(1);
    await stopBridge();

    const restarted = await startBridge(ha);
    await settle(restarted.bem);
    expect(version()).toBe(1);
  });

  // Fails the Descriptor read of vacuum_b inside the signature while
  // failures() says so, matter.js itself reads the state too.
  function unreadableInSignature(failures: () => boolean) {
    const proto = BridgeEndpointManager.prototype as unknown as {
      topologySignature(...args: unknown[]): string;
    };
    const signature = proto.topologySignature;
    let inSignature = false;
    vi.spyOn(proto, "topologySignature").mockImplementation(function (
      this: BridgeEndpointManager,
      ...args: unknown[]
    ) {
      inSignature = true;
      try {
        return signature.apply(this, args);
      } finally {
        inSignature = false;
      }
    });
    const stateOf = Endpoint.prototype.stateOf;
    vi.spyOn(Endpoint.prototype, "stateOf").mockImplementation(function (
      this: Endpoint,
      ...args: Parameters<Endpoint["stateOf"]>
    ) {
      if (
        inSignature &&
        args[0] === DescriptorServer &&
        this.id === "vacuum_b" &&
        failures()
      ) {
        throw new Error("not initialized");
      }
      return stateOf.apply(this, args);
    });
  }

  it("retries a compare that met an unreadable part instead of bumping (#543)", async () => {
    const { bem } = await startBridge(makeHa(["vacuum.a", "vacuum.b"]));
    await settle(bem);
    let fail = 1;
    unreadableInSignature(() => fail-- > 0);

    await compare(bem);
    expect(version()).toBe(1);
    expect(settleArmed(bem)).toBe(true);
    await settle(bem);
    expect(version()).toBe(1);
    expect(settleArmed(bem)).toBe(false);
  });

  it("announces once when a part stays unreadable through every retry (#543)", async () => {
    const { bem } = await startBridge(makeHa(["vacuum.a", "vacuum.b"]));
    await settle(bem);
    unreadableInSignature(() => true);

    await compare(bem);
    let compares = 1;
    while (settleArmed(bem) && compares < 10) {
      await settle(bem);
      compares++;
    }
    expect(compares).toBe(4);
    expect(version()).toBe(2);
    await compare(bem);
    expect(version()).toBe(2);
  });

  it("bumps once when the signature write fails and is retried", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    const storage = bem.root.env.get(ServerNodeStore).storage;
    const createContext = storage.createContext.bind(storage);
    let failWrite = true;
    let failedWrites = 0;
    vi.spyOn(storage, "createContext").mockImplementation((name) => {
      const context = createContext(name);
      if (name === "hamh" && failWrite) {
        failWrite = false;
        vi.spyOn(context, "set").mockImplementationOnce(async () => {
          failedWrites++;
          throw new Error("disk full");
        });
      }
      return context;
    });

    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    await settle(bem);
    expect(failedWrites).toBe(1);
    expect(version()).toBe(2);
    await compare(bem);
    expect(version()).toBe(2);
    const signature = (
      bem as unknown as { topologySignature(): string }
    ).topologySignature();
    expect(await createContext("hamh").get<string>("topology", "")).toBe(
      signature,
    );
  });

  it("retries the announcement after the handler failed", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    const node = server!;
    let failBump = true;
    bem.setTopologyChangeHandler(async (change) => {
      if (failBump) {
        failBump = false;
        throw new Error("lock held");
      }
      await node.act("topology change", (agent) =>
        agent.get(BasicInformationServer).increaseConfigurationVersion(change),
      );
    });

    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    await settle(bem);
    expect(version()).toBe(1);
    expect(settleArmed(bem)).toBe(true);
    await settle(bem);
    expect(version()).toBe(2);
    expect(settleArmed(bem)).toBe(false);
  });

  it("bumps for a stored signature that moved away after the last bump", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    await settle(bem);
    expect(version()).toBe(2);

    // a wipe and a first run with another set leave a foreign v2 signature
    const storage = bem.root.env
      .get(ServerNodeStore)
      .storage.createContext("hamh");
    await storage.set("topology", "v2:0123456789abcdef");
    await compare(bem);
    expect(version()).toBe(3);
  });

  it("gives a new change its own retries after a failed one spent them", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    bem.setTopologyChangeHandler(async () => {
      throw new Error("lock held");
    });

    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    let compares = 0;
    while (settleArmed(bem) && compares < 10) {
      await settle(bem);
      compares++;
    }
    expect(settleArmed(bem), "settle timer still armed after 10 rounds").toBe(
      false,
    );
    expect(compares).toBe(4);

    addEntity(ha, "vacuum.c");
    await bem.refreshDevices();
    expect(settleArmed(bem)).toBe(true);
    await settle(bem);
    expect(settleArmed(bem)).toBe(true);
  });

  it("retries a failed announcement after a short delay and gives up with one warning", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    bem.setTopologyChangeHandler(async () => {
      throw new Error("lock held");
    });
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const armedDelay = () => {
      const timer = (bem as unknown as { topologyTimer?: unknown })
        .topologyTimer;
      const i = timeouts.mock.results.findIndex((r) => r.value === timer);
      return timeouts.mock.calls[i]?.[1];
    };
    const log = (bem as unknown as { log: Logger }).log;
    const givenUp = () =>
      vi
        .mocked(log.warn)
        .mock.calls.filter((c) => String(c[0]).startsWith("Giving up")).length;

    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    expect(armedDelay()).toBe(90_000);
    for (let i = 0; i < 3; i++) {
      await settle(bem);
      expect(armedDelay()).toBe(10_000);
      expect(givenUp()).toBe(0);
    }
    await settle(bem);
    expect(settleArmed(bem)).toBe(false);
    expect(givenUp()).toBe(1);
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

// What a controller on loopback receives when the endpoint set moves (#545).
describe("controller view of a changed endpoint set", () => {
  interface Report {
    ep: number;
    cluster: number;
    attr: number;
    value: unknown;
  }

  let ctl: ServerNode | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    // the controller must ack the last report, or the bridge close waits
    // out the retransmissions of a dead peer
    await stopBridge();
    await ctl?.close().catch(() => {});
    ctl = undefined;
  });

  const PARTS = Descriptor.Complete.attributes.partsList.id;
  const DESCRIPTOR = Descriptor.Complete.id;

  const collect =
    (into: Report[]) =>
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
    async (data: any) => {
      for await (const chunk of data) {
        for (const r of chunk) {
          if (r.kind !== "attr-value") continue;
          into.push({
            ep: Number(r.path.endpointId),
            cluster: Number(r.path.clusterId),
            attr: Number(r.path.attributeId),
            value: r.value,
          });
        }
      }
    };

  const partsOf = (seen: Report[], ep: number) =>
    seen
      .filter(
        (r) => r.ep === ep && r.cluster === DESCRIPTOR && r.attr === PARTS,
      )
      .map((r) => (r.value as unknown[]).map(Number));

  const numberOf = (bem: BridgeEndpointManager, id: string) =>
    [...bem.root.parts].find((p) => p.id === id)!.number;

  async function commission() {
    await server!.start();
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
    const port = (server!.state as any).network.operationalPort as number;
    expect(port).toBeGreaterThan(0);
    const cenv = new Environment("ctl", Environment.default);
    cenv.get(VariableService).set("storage.path", join(dir, "ctl"));
    ctl = await ServerNode.create(
      ServerNode.RootEndpoint.with(ControllerBehavior),
      {
        // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
        environment: cenv as any,
        id: "ctl",
        network: { port: 0 },
        basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
      },
    );
    await ctl.start();
    const client = await ctl.peers.forDescriptor({
      addresses: [{ type: "udp", ip: "127.0.0.1", port }],
      deviceIdentifier: "bem-cv",
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
    return client;
  }

  // Resolves once the priming report is in, then starts from an empty list.
  async function subscribe(
    client: Awaited<ReturnType<typeof commission>>,
    req: Subscribe,
  ) {
    const seen: Report[] = [];
    req.updated = collect(seen);
    await client.interaction.subscribe(req);
    await vi.waitFor(() => expect(partsOf(seen, 0)).not.toHaveLength(0));
    seen.length = 0;
    return seen;
  }

  const partsOnly = (bem: BridgeEndpointManager) =>
    Subscribe(
      { keepSubscriptions: true },
      Read.Attribute({
        endpoint: EndpointNumber(0),
        cluster: Descriptor.Complete,
        attributes: ["partsList"],
      }),
      Read.Attribute({
        endpoint: bem.root.number,
        cluster: Descriptor.Complete,
        attributes: ["partsList"],
      }),
    );

  const wildcard = () =>
    Subscribe({ keepSubscriptions: true, attributes: [{}] });

  const poll = { timeout: 5_000 };

  it(
    "reports partsList to a partsList-only subscriber after a runtime add",
    { timeout: 30_000 },
    async () => {
      const ha = makeHa(["vacuum.a"]);
      const { bem } = await startBridge(ha);
      const client = await commission();
      const seen = await subscribe(client, partsOnly(bem));

      addEntity(ha, "vacuum.b");
      await bem.refreshDevices();
      const added = numberOf(bem, "vacuum_b");
      await expect
        .poll(() => partsOf(seen, 0).some((p) => p.includes(added)), poll)
        .toBe(true);
      await expect
        .poll(
          () => partsOf(seen, bem.root.number).some((p) => p.includes(added)),
          poll,
        )
        .toBe(true);
    },
  );

  it(
    "reports the new endpoint to a wildcard subscriber and reads it back",
    { timeout: 30_000 },
    async () => {
      const ha = makeHa(["vacuum.a"]);
      const { bem } = await startBridge(ha);
      const client = await commission();
      const seen = await subscribe(client, wildcard());

      addEntity(ha, "vacuum.b");
      await bem.refreshDevices();
      const added = numberOf(bem, "vacuum_b");
      await expect
        .poll(() => partsOf(seen, 0).some((p) => p.includes(added)), poll)
        .toBe(true);
      await expect
        .poll(
          () => partsOf(seen, bem.root.number).some((p) => p.includes(added)),
          poll,
        )
        .toBe(true);
      await expect
        .poll(() => seen.some((r) => r.ep === added), poll)
        .toBe(true);

      const req = Read(
        Read.Attribute({
          endpoint: added,
          cluster: Descriptor.Complete,
          attributes: ["deviceTypeList"],
        }),
        Read.Attribute({
          endpoint: added,
          cluster: BridgedDeviceBasicInformation.Complete,
          attributes: ["reachable", "uniqueId", "nodeLabel"],
        }),
      );
      (req as { includeKnownVersions?: boolean }).includeKnownVersions = true;
      const read: Report[] = [];
      await collect(read)(client.interaction.read(req));
      const value = (cluster: number, attr: number) =>
        read.find((r) => r.cluster === cluster && r.attr === attr)?.value;
      const bdbi = BridgedDeviceBasicInformation.Complete;
      const types = value(
        DESCRIPTOR,
        Descriptor.Complete.attributes.deviceTypeList.id,
      ) as { deviceType: number }[];
      // RoboticVacuumCleaner
      expect(types.map((t) => Number(t.deviceType))).toContain(0x74);
      const served = [...bem.root.parts]
        .find((p) => p.id === "vacuum_b")!
        .stateOf(BridgedDeviceBasicInformationServer);
      expect(served.uniqueId).toMatch(/./);
      expect(value(bdbi.id, bdbi.attributes.reachable.id)).toBe(true);
      expect(value(bdbi.id, bdbi.attributes.uniqueId.id)).toBe(served.uniqueId);
      expect(value(bdbi.id, bdbi.attributes.nodeLabel.id)).toBe("vacuum.b");
    },
  );

  it(
    "reports partsList without an endpoint the filter dropped",
    { timeout: 30_000 },
    async () => {
      const { bem, provider } = await startBridge(
        makeHa(["vacuum.a", "vacuum.b"]),
      );
      const kept = numberOf(bem, "vacuum_a");
      const dropped = numberOf(bem, "vacuum_b");
      const client = await commission();
      const seen = await subscribe(client, partsOnly(bem));

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
      expect(bem.root.parts.size).toBe(1);
      for (const ep of [0, bem.root.number]) {
        await expect
          .poll(
            () =>
              partsOf(seen, ep).some(
                (p) => p.includes(kept) && !p.includes(dropped),
              ),
            poll,
          )
          .toBe(true);
      }
    },
  );

  it("bumps ConfigurationVersion once from the settle timer", async () => {
    const ha = makeHa(["vacuum.a"]);
    const { bem } = await startBridge(ha);
    await settle(bem);
    const before = version();

    // no controller here, a live session must never run on the fake clock
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    addEntity(ha, "vacuum.b");
    await bem.refreshDevices();
    expect(settleArmed(bem)).toBe(true);
    expect(version()).toBe(before);
    await vi.advanceTimersByTimeAsync(90_000);

    await expect.poll(version, poll).toBe(before + 1);
    expect(settleArmed(bem)).toBe(false);
    expect(version()).toBe(before + 1);
  });

  it(
    "reports the bumped ConfigurationVersion to a wildcard subscriber",
    { timeout: 30_000 },
    async () => {
      const ha = makeHa(["vacuum.a"]);
      const { bem } = await startBridge(ha);
      await settle(bem);
      const client = await commission();
      const seen = await subscribe(client, wildcard());
      const before = version();

      addEntity(ha, "vacuum.b");
      await bem.refreshDevices();
      await settle(bem);
      expect(version()).toBe(before + 1);
      const info = BasicInformation.Complete;
      // late priming chunks may still carry the old value
      const reported = () =>
        seen
          .filter(
            (r) =>
              r.ep === 0 &&
              r.cluster === info.id &&
              r.attr === info.attributes.configurationVersion.id,
          )
          .map((r) => Number(r.value));
      await expect.poll(reported, poll).toContain(before + 1);
      expect(Math.max(...reported())).toBe(before + 1);
    },
  );

  it("keeps the version across a plugin restart and bumps for a new plugin device", async () => {
    let ctx: PluginContext | undefined;
    const plugin: MatterHubPlugin = {
      name: "cv-plugin",
      version: "1.0.0",
      async onStart(context) {
        ctx = context;
        await context.registerDevice({
          id: "p1",
          name: "P1",
          deviceType: "on_off_light",
          clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
        });
      },
    };
    const plugins = new PluginManager(BRIDGE_ID, dir);
    await plugins.registerBuiltIn(plugin);
    const { bem } = await startBridge(makeHa(["vacuum.a"]), undefined, plugins);
    await settle(bem);
    expect([...bem.root.parts].some((p) => p.id.includes("p1"))).toBe(true);
    const before = version();

    await bem.stopPlugins();
    expect([...bem.root.parts].some((p) => p.id.includes("p1"))).toBe(false);
    await plugins.registerBuiltIn(plugin);
    await bem.startPlugins();
    expect([...bem.root.parts].some((p) => p.id.includes("p1"))).toBe(true);
    await compare(bem);
    expect(version()).toBe(before);

    await ctx!.registerDevice({
      id: "p2",
      name: "P2",
      deviceType: "on_off_light",
      clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
    });
    expect([...bem.root.parts].some((p) => p.id.includes("p2"))).toBe(true);
    await compare(bem);
    expect(version()).toBe(before + 1);
  });
});
