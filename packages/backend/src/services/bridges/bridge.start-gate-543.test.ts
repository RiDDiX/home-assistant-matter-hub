import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeData,
  BridgeStatus,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { PluginManager } from "../../plugins/plugin-manager.js";
import type { MatterHubPlugin } from "../../plugins/types.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../home-assistant/home-assistant-actions.js";
import { HomeAssistantRegistry } from "../home-assistant/home-assistant-registry.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { Bridge } from "./bridge.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";
import { ServerModeBridge } from "./server-mode-bridge.js";

// #543 round 4: a start whose first refresh was deferred (HA not running or
// the registry empty) put the node online with an empty aggregator, and a
// commissioned controller watched every device leave and come back a refresh
// later. Plugin devices did the same on every restart.

const BRIDGE_ID = "bridge-gate";

class FakeIdentityStorage {
  // biome-ignore lint/suspicious/noExplicitAny: minimal record store
  private m = new Map<string, any>();
  getIdentity(_b: string, k: string) {
    return this.m.get(k);
  }
  getBridgeIdentities() {
    return this.m;
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal record store
  setIdentity(_b: string, k: string, r: any) {
    this.m.set(k, r);
  }
  markIdentityMissing() {}
  clearIdentityMissing() {}
  async deleteIdentity(_b: string, k: string) {
    this.m.delete(k);
  }
  async deleteBridgeIdentities() {
    this.m.clear();
  }
}

const noMappings = {
  getMapping: () => undefined,
  getMappingsForBridge: () => [],
  markMappingMissing() {},
  clearMappingMissing() {},
} as unknown as EntityMappingStorage;

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
  markRefreshIncomplete(): void;
  grantRefreshRetries(): void;
}

function makeHa(ids: string[]): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
    markRefreshIncomplete() {},
    grantRefreshRetries() {},
  };
  for (const id of ids) {
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
  return ha;
}

function makeProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: BRIDGE_ID,
    name: "b",
    port: 0,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: "vacuum.*" }],
      exclude: [],
      includeMode: "any",
    },
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
  } as unknown as BridgeData);
}

const makeLog = () => ({
  debug: vi.fn(),
  debugCtx: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const notReady = (log: ReturnType<typeof makeLog>) =>
  log.warn.mock.calls.filter((c) =>
    String(c[0]).includes("Home Assistant data not ready"),
  ).length;

let dir: string;
let server: ServerNode | undefined;
let manager: BridgeEndpointManager | undefined;
let bridge: Bridge | ServerModeBridge | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-gate-"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await bridge?.stop().catch(() => {});
  await manager?.dispose().catch(() => {});
  await server?.close().catch(() => {});
  bridge = manager = server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function fakeSessions() {
  return {
    start() {},
    stop() {},
    reconfigure: vi.fn(),
    closeActiveSessions: async () => {},
  };
}

describe("bridge start gate (#543 round 4)", () => {
  async function make(
    ha: FakeHa,
    opts: { haRunning?: boolean; plugins?: PluginManager } = {},
  ) {
    const provider = makeProvider();
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    env.set(HomeAssistantRegistry, ha as any);
    const node = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "gate-node",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    server = node;
    const client = {
      connection: {},
      haRunning: opts.haRunning ?? true,
      runningSince: 0,
    };
    const bem = new BridgeEndpointManager(
      // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
      client as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
      new BridgeRegistry(ha as any, provider),
      noMappings,
      new FakeIdentityStorage() as unknown as EntityIdentityStorage,
      provider.id,
      makeLog() as unknown as Logger,
      opts.plugins,
    );
    manager = bem;
    await node.add(bem.root);
    bem.setTopologyChangeHandler(async () => {});
    vi.spyOn(bem, "startObserving").mockResolvedValue();
    // what the node holds the moment it would go online
    const online: string[][] = [];
    vi.spyOn(node, "start").mockImplementation(async () => {
      online.push([...bem.root.parts].map((p) => p.id));
    });
    const log = makeLog();
    const b = Object.create(Bridge.prototype);
    Object.assign(b, {
      log,
      dataProvider: provider,
      server: node,
      endpointManager: bem,
      status: { code: BridgeStatus.Stopped },
      lastSyncedStates: new Map(),
      autoForceSyncTimer: null,
      commissioningCheckTimer: null,
      sessions: fakeSessions(),
    });
    bridge = b as Bridge;
    return { bridge: b as Bridge, bem, client, online, log };
  }

  // the node and the endpoints are built on real timers, the wait on fake ones
  async function startOnFakeTimers(b: Bridge, steps: () => Promise<void>) {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    const starting = b.start();
    await steps();
    await starting;
  }

  it("goes online only once HA runs, with every device mounted", async () => {
    const { bridge, client, online, log } = await make(
      makeHa(["vacuum.a", "vacuum.b", "vacuum.c"]),
      { haRunning: false },
    );
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(5_999);
      expect(online).toHaveLength(0);
      client.haRunning = true;
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(online).toHaveLength(1);
    expect(online[0]).toHaveLength(3);
    expect(bridge.data.status).toBe(BridgeStatus.Running);
    expect(notReady(log)).toBe(0);
  });

  it("reloads an empty registry before it gives up", async () => {
    const ha = makeHa([]);
    const filled = makeHa(["vacuum.a", "vacuum.b"]);
    const reload = vi.fn(async () => {
      ha.entities = filled.entities;
      ha.states = filled.states;
      return true;
    });
    Object.assign(ha, { reload });
    const { bridge, online } = await make(ha);
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(reload).toHaveBeenCalledOnce();
    expect(online[0]).toHaveLength(2);
  });

  it("starts with what it has after the bound when HA never gets ready", async () => {
    const { bridge, online, log } = await make(makeHa(["vacuum.a"]), {
      haRunning: false,
    });
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(online).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(online).toHaveLength(1);
    expect(online[0]).toHaveLength(0);
    expect(notReady(log)).toBe(1);
    expect(bridge.data.status).toBe(BridgeStatus.Running);
  });

  it("a later start does not wait again for an outage an earlier one gave up on", async () => {
    const { bridge, client, online, log } = await make(makeHa(["vacuum.a"]));
    // a start with HA ready clears a give up shared from an earlier test
    await bridge.start();
    await bridge.stop();
    client.haRunning = false;
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(online).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(online).toHaveLength(2);
    await bridge.stop();
    await bridge.start();
    expect(online).toHaveLength(3);
    expect(notReady(log)).toBe(2);
  });

  it("waits again for an outage long after an earlier give up", async () => {
    const { bridge, client, online } = await make(makeHa(["vacuum.a"]));
    await bridge.start();
    await bridge.stop();
    client.haRunning = false;
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(online).toHaveLength(2);
    await bridge.stop();
    // HA came back through the auto-refresh and failed again later
    await vi.advanceTimersByTimeAsync(120_000);
    const starting = bridge.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(online).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    expect(online).toHaveLength(3);
  });

  it("a stop during the wait ends it at once and the node stays offline", async () => {
    const { bridge, client, online } = await make(makeHa(["vacuum.a"]));
    await bridge.start();
    await bridge.stop();
    client.haRunning = false;
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(4000);
      await bridge.stop();
    });

    expect(online).toHaveLength(1);
    expect(bridge.data.status).toBe(BridgeStatus.Stopped);
  });

  it("does not wait for an entity that keeps failing", async () => {
    const { bridge, bem, online, log } = await make(
      makeHa(["vacuum.a", "vacuum.bad"]),
    );
    const add = bem.root.add.bind(bem.root);
    vi.spyOn(bem.root, "add").mockImplementation((async (
      ep: Parameters<typeof add>[0],
    ) => {
      if ((ep as { entityId?: string }).entityId === "vacuum.bad") {
        throw new Error("boom");
      }
      return add(ep);
    }) as typeof add);
    const refresh = vi.spyOn(bem, "refreshDevices");
    await startOnFakeTimers(bridge, async () => {});

    expect(refresh).toHaveBeenCalledOnce();
    await expect(refresh.mock.results[0].value).resolves.toBe(false);
    expect(online[0]).toHaveLength(1);
    expect(notReady(log)).toBe(0);
  });

  it("does not wait on a normal start", async () => {
    const { bridge, bem, online, log } = await make(
      makeHa(["vacuum.a", "vacuum.b"]),
    );
    const refresh = vi.spyOn(bem, "refreshDevices");
    await startOnFakeTimers(bridge, async () => {});

    expect(refresh).toHaveBeenCalledOnce();
    expect(online[0]).toHaveLength(2);
    expect(notReady(log)).toBe(0);
  });

  it("mounts plugin devices before the node goes online", async () => {
    const plugin: MatterHubPlugin = {
      name: "gate-plugin",
      version: "1.0.0",
      async onStart(context) {
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
    const { bridge, online } = await make(makeHa(["vacuum.a"]), { plugins });
    await startOnFakeTimers(bridge, async () => {});

    expect(online[0]).toContain("plugin_p1");
    expect(online[0]).toHaveLength(2);
  });

  it("an update overlapping a stop re-arms nothing", async () => {
    const { bridge, bem } = await make(makeHa(["vacuum.a"]));
    await bridge.start();
    const b = bridge as unknown as {
      sessions: { reconfigure: ReturnType<typeof vi.fn> };
      autoForceSyncTimer: unknown;
      dataProvider: BridgeDataProvider;
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.spyOn(bem, "refreshDevices").mockImplementation(async () => {
      await held;
      return true;
    });

    const data = b.dataProvider;
    // autoForceSync on, so a re-arm would leave a timer behind
    const updating = bridge.update({
      id: data.id,
      name: data.name,
      port: data.port,
      filter: data.filter,
      featureFlags: { autoForceSync: true },
    });
    await vi.waitFor(() => expect(bem.refreshDevices).toHaveBeenCalled());
    const stopping = bridge.stop();
    // the stop is in flight, its status write still ahead
    await Promise.resolve();
    release();
    await updating;
    await stopping;

    expect(b.sessions.reconfigure).not.toHaveBeenCalled();
    expect(b.autoForceSyncTimer).toBeNull();
  });
});

describe("server mode start gate (#543 round 4)", () => {
  it("goes online only once HA runs", async () => {
    const provider = makeProvider();
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    const node = new ServerModeServerNode(env as any, provider);
    server = node;
    await node.construction.ready;
    let haRunning = false;
    let mounted = 0;
    const em = {
      devices: [],
      failedEntities: [],
      get refreshDeferred() {
        return !haRunning;
      },
      refreshDevices: vi.fn(async () => {
        if (haRunning) mounted = 1;
        return haRunning;
      }),
      startObserving: async () => {},
      stopObserving() {},
    };
    const seen: number[] = [];
    vi.spyOn(node, "start").mockImplementation(async () => {
      seen.push(mounted);
    });
    const b = Object.create(ServerModeBridge.prototype);
    Object.assign(b, {
      log: makeLog(),
      dataProvider: provider,
      server: node,
      endpointManager: em,
      status: { code: BridgeStatus.Stopped },
      lastSyncedStates: new Map(),
      autoForceSyncTimer: null,
      commissioningCheckTimer: null,
      warmStartTimer: null,
      sessions: fakeSessions(),
    });
    bridge = b as ServerModeBridge;

    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    const starting = (b as ServerModeBridge).start();
    await vi.advanceTimersByTimeAsync(5_999);
    expect(seen).toHaveLength(0);
    haRunning = true;
    await vi.advanceTimersByTimeAsync(3000);
    await starting;

    expect(seen).toEqual([1]);
    expect(em.refreshDevices).toHaveBeenCalledTimes(3);
  });
});
