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
import { FabricManager } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyEndpoint } from "../../matter/endpoints/legacy/legacy-endpoint.js";
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
import { ServerModeEndpointManager } from "./server-mode-endpoint-manager.js";

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
      state: id.startsWith("script.") ? "off" : "docked",
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
      include: [
        { type: HomeAssistantMatcherType.Pattern, value: "vacuum.*" },
        { type: HomeAssistantMatcherType.Pattern, value: "script.*" },
      ],
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

function makeEnvironment(ha: FakeHa, provider: BridgeDataProvider) {
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
  return env;
}

describe("bridge start gate (#543 round 4)", () => {
  async function make(
    ha: FakeHa,
    opts: {
      haRunning?: boolean;
      plugins?: PluginManager;
      provider?: BridgeDataProvider;
    } = {},
  ) {
    const provider = opts.provider ?? makeProvider();
    const env = makeEnvironment(ha, provider);
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    const registry = new BridgeRegistry(ha as any, provider);
    const bem = new BridgeEndpointManager(
      // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
      client as any,
      registry,
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
    return {
      bridge: b as Bridge,
      bem,
      parent: bem.root,
      client,
      online,
      log,
      registry,
    };
  }

  // the node and the endpoints are built on real timers, the wait on fake ones
  async function startOnFakeTimers(
    b: Bridge | ServerModeBridge,
    steps: () => Promise<void>,
  ) {
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

  async function waitForStartupPoll() {
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await vi.waitFor(() =>
        expect(timer).toHaveBeenCalledWith(expect.any(Function), 3000),
      );
    } finally {
      timer.mockRestore();
    }
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

  // a host reboot: HA needs longer than 30s, a paired bridge must not go
  // online empty
  function commission(b: Bridge | ServerModeBridge) {
    vi.spyOn(b.server.env.get(FabricManager), "length", "get").mockReturnValue(
      1,
    );
  }

  it("a commissioned bridge waits past 30s and starts with every device", async () => {
    const { bridge, client, online, log } = await make(
      makeHa(["vacuum.a", "vacuum.b"]),
      { haRunning: false },
    );
    commission(bridge);
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(39_000);
      expect(online).toHaveLength(0);
      client.haRunning = true;
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(online).toEqual([[expect.any(String), expect.any(String)]]);
    expect(notReady(log)).toBe(0);
    expect(bridge.data.status).toBe(BridgeStatus.Running);
  });

  it.each([
    ["bridge", HomeAssistantMatcherType.Pattern, "script.*"],
    ["server", HomeAssistantMatcherType.Pattern, "script.*"],
    ["bridge", HomeAssistantMatcherType.DeviceClass, "cleaning"],
    ["server", HomeAssistantMatcherType.DeviceClass, "cleaning"],
    ["server", HomeAssistantMatcherType.AnyFieldRegex, "device_class=cleaning"],
  ] as const)("a commissioned %s reloads a reserved endpoint matching %s before starting", async (mode, type, value) => {
    const entityId = "script.clean";
    const ha = makeHa(["vacuum.a", entityId]);
    ha.states[entityId].state = "unavailable";
    const provider = makeProvider();
    const { bridge, parent, registry } =
      mode === "bridge"
        ? await make(ha, { provider })
        : await makeServerMode(ha, provider);
    const previous = await LegacyEndpoint.create(
      registry,
      entityId,
      undefined,
      undefined,
      mode === "server",
    );
    if (!previous) throw new Error("Script endpoint was not created");
    await parent.add(previous);
    const { id, number } = previous;
    await previous.close();
    provider.filter.include[1] = { type, value };
    const state = ha.states[entityId];
    state.state = "off";
    state.attributes.device_class = "cleaning";
    delete ha.states[entityId];
    let releaseReload!: () => void;
    const reload = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseReload = () => {
            ha.states[entityId] = state;
            resolve(true);
          };
        }),
    );
    Object.assign(ha, { reload });
    commission(bridge);
    const online: Map<string, number>[] = [];
    vi.mocked(bridge.server.start).mockImplementation(async () => {
      online.push(new Map([...parent.parts].map((p) => [p.id, p.number])));
    });

    await startOnFakeTimers(bridge, async () => {
      await vi.waitFor(() =>
        expect(online.length + reload.mock.calls.length).toBeGreaterThan(0),
      );
      expect(online).toEqual([]);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(online).toHaveLength(0);
      expect(reload).toHaveBeenCalledOnce();
      releaseReload();
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(online).toHaveLength(1);
    expect([...online[0].keys()].sort()).toEqual([id, "vacuum_a"]);
    expect(online[0].get(id)).toBe(number);
  });

  it.each([
    ["bridge", "create"],
    ["bridge", "attach"],
    ["server", "create"],
    ["server", "attach"],
  ] as const)("a commissioned %s retries a reserved endpoint after a transient %s failure", async (mode, failure) => {
    const entityId = "script.clean";
    const ha = makeHa(["vacuum.a", entityId]);
    const { bridge, parent, registry } =
      mode === "bridge" ? await make(ha) : await makeServerMode(ha);
    const previous = await LegacyEndpoint.create(
      registry,
      entityId,
      undefined,
      undefined,
      mode === "server",
    );
    if (!previous) throw new Error("Script endpoint was not created");
    await parent.add(previous);
    const { id, number } = previous;
    await previous.close();

    let fail = true;
    const rejected = vi.fn(() => {
      if (fail) throw new Error("Temporary endpoint failure");
    });
    if (failure === "create") {
      const create = LegacyEndpoint.create.bind(LegacyEndpoint);
      vi.spyOn(LegacyEndpoint, "create").mockImplementation(async (...args) => {
        if (args[1] === entityId) rejected();
        return create(...args);
      });
    } else {
      const add = parent.add.bind(parent);
      vi.spyOn(parent, "add").mockImplementation(async (endpoint) => {
        if (endpoint instanceof LegacyEndpoint && endpoint.id === id)
          rejected();
        return add(endpoint);
      });
    }
    commission(bridge);
    const online: Map<string, number>[] = [];
    vi.mocked(bridge.server.start).mockImplementation(async () => {
      online.push(new Map([...parent.parts].map((p) => [p.id, p.number])));
    });

    await startOnFakeTimers(bridge, async () => {
      await waitForStartupPoll();
      expect(rejected).toHaveBeenCalled();
      expect(online).toHaveLength(0);
      fail = false;
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(online).toHaveLength(1);
    expect([...online[0].keys()].sort()).toEqual([id, "vacuum_a"]);
    expect(online[0].get(id)).toBe(number);
  });

  it("a commissioned bridge waits only 30s for an endpoint that keeps failing", async () => {
    const entityId = "script.clean";
    const { bridge, bem, registry, online, log } = await make(
      makeHa(["vacuum.a", entityId]),
    );
    const previous = await LegacyEndpoint.create(registry, entityId);
    if (!previous) throw new Error("Script endpoint was not created");
    await bem.root.add(previous);
    await previous.close();
    const create = LegacyEndpoint.create.bind(LegacyEndpoint);
    const fail = vi.fn(() => {
      throw new Error("Permanent endpoint failure");
    });
    vi.spyOn(LegacyEndpoint, "create").mockImplementation(async (...args) => {
      if (args[1] === entityId) fail();
      return create(...args);
    });
    commission(bridge);

    await startOnFakeTimers(bridge, async () => {
      await waitForStartupPoll();
      expect(fail).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(online).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(online).toEqual([["vacuum_a"]]);
    expect(log.warn).toHaveBeenCalledWith(
      "Previously allocated endpoints not ready after 30s, starting with what the bridge has",
    );
  });

  it("a commissioned bridge started before HA waits only 30s more for an endpoint that keeps failing", async () => {
    const entityId = "script.clean";
    const { bridge, bem, client, registry, online, log } = await make(
      makeHa(["vacuum.a", entityId]),
      { haRunning: false },
    );
    const previous = await LegacyEndpoint.create(registry, entityId);
    if (!previous) throw new Error("Script endpoint was not created");
    await bem.root.add(previous);
    await previous.close();
    const create = LegacyEndpoint.create.bind(LegacyEndpoint);
    vi.spyOn(LegacyEndpoint, "create").mockImplementation(async (...args) => {
      if (args[1] === entityId) throw new Error("Permanent endpoint failure");
      return create(...args);
    });
    commission(bridge);

    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(6_000);
      client.haRunning = true;
      // the first poll with HA up builds endpoints on real timers
      const timer = vi.spyOn(globalThis, "setTimeout");
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() =>
        expect(timer).toHaveBeenCalledWith(expect.any(Function), 3000),
      );
      timer.mockRestore();
      expect(bem.allocatedEndpointFailed).toBe(true);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(online).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(online).toEqual([["vacuum_a"]]);
    expect(log.warn).toHaveBeenCalledWith(
      "Previously allocated endpoints not ready after 39s, starting with what the bridge has",
    );
  });

  it.each([
    "bridge",
    "server",
  ] as const)("keeps the %s device class selection across missing snapshots", async (mode) => {
    const selected = "script.clean";
    const excluded = "script.skipped";
    const ha = makeHa(["vacuum.a", selected, excluded]);
    ha.entities[selected].unique_id = "original";
    ha.states[selected].attributes.device_class = "cleaning";
    ha.states[excluded].attributes.device_class = "muted";
    const provider = makeProvider();
    const primary = {
      type: HomeAssistantMatcherType.AnyFieldRegex,
      value: "device_class=cleaning\\b",
    };
    provider.filter.include = [
      primary,
      { type: HomeAssistantMatcherType.Pattern, value: "vacuum.a" },
      { type: HomeAssistantMatcherType.Pattern, value: excluded },
    ];
    provider.filter.exclude.push({
      type: HomeAssistantMatcherType.DeviceClass,
      value: "muted",
    });
    const { bridge, parent, registry } =
      mode === "bridge"
        ? await make(ha, { provider })
        : await makeServerMode(ha, provider);

    await bridge.start();
    const original = parent.parts.find((p) => p.id === "script_clean");
    if (!original) throw new Error("Selected script endpoint was not mounted");
    const number = original.number;
    expect(parent.parts.find((p) => p.id === "script_skipped")).toBeUndefined();

    const fullEntities = ha.entities;
    ha.entities = {};
    await bridge.refreshDevices();
    expect(parent.parts.find((p) => p.id === original.id)).toBe(original);
    ha.entities = fullEntities;

    const selectedState = ha.states[selected];
    const excludedState = ha.states[excluded];
    delete ha.states[selected];
    delete ha.states[excluded];
    for (let i = 0; i < 2; i++) {
      ha.snapshotGeneration++;
      await bridge.refreshDevices();
      const present = parent.parts.find((p) => p.id === original.id);
      expect(present).toBe(original);
      expect(present?.number).toBe(number);
      expect(
        parent.parts.find((p) => p.id === "script_skipped"),
      ).toBeUndefined();
      expect(registry.firstEntityMatching(primary)).toBe(selected);
      expect(registry.initialState(selected)).toBeUndefined();
    }

    ha.states[selected] = selectedState;
    ha.states[excluded] = excludedState;
    ha.states[selected].state = "unavailable";
    delete ha.states[selected].attributes.device_class;
    delete ha.states[excluded].attributes.device_class;
    await bridge.refreshDevices();
    expect(registry.firstEntityMatching(primary)).toBe(selected);
    const classless = parent.parts.find((p) => p.id === "script_skipped");
    expect(classless).toBeDefined();
    ha.states[excluded].state = "unavailable";
    await bridge.refreshDevices();
    expect(parent.parts.find((p) => p.id === "script_skipped")).toBe(classless);

    ha.states[selected].state = "off";
    await bridge.refreshDevices();
    expect(registry.firstEntityMatching(primary)).toBeUndefined();

    expect(parent.parts.find((p) => p.id === original.id)).toBeUndefined();

    ha.states[selected].attributes.device_class = "cleaning";
    ha.states[excluded].attributes.device_class = "muted";
    await bridge.refreshDevices();
    expect(parent.parts.find((p) => p.id === original.id)?.number).toBe(number);
    expect(parent.parts.find((p) => p.id === "script_skipped")).toBeUndefined();

    delete ha.states[selected];
    ha.entities[selected].unique_id = "new";
    await bridge.refreshDevices();
    expect(parent.parts.find((p) => p.id === original.id)).toBeUndefined();
  });

  it("a commissioned bridge waits only 30s for a reserved endpoint's state that never arrives", async () => {
    const entityId = "script.clean";
    const ha = makeHa(["vacuum.a", entityId]);
    const { bridge, bem, registry, online, log } = await make(ha);
    const previous = await LegacyEndpoint.create(registry, entityId);
    if (!previous) throw new Error("Script endpoint was not created");
    await bem.root.add(previous);
    await previous.close();
    delete ha.states[entityId];
    // the wait has begun once it reloads, the endpoints build on real I/O
    let reloaded!: () => void;
    const waiting = new Promise<void>((r) => (reloaded = r));
    Object.assign(ha, {
      reload: async () => {
        reloaded();
        return true;
      },
    });
    commission(bridge);

    await startOnFakeTimers(bridge, async () => {
      await waiting;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(online).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(online).toEqual([["vacuum_a"]]);
    expect(notReady(log)).toBe(1);
  });

  it("a commissioned bridge starts immediately when a new entity lacks state", async () => {
    const ha = makeHa(["vacuum.a", "script.clean"]);
    delete ha.states["script.clean"];
    const reload = vi.fn();
    Object.assign(ha, { reload });
    const { bridge, online } = await make(ha);
    commission(bridge);

    await startOnFakeTimers(bridge, async () => {});

    expect(online).toEqual([["vacuum_a"]]);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    "fresh",
    "excluded",
  ] as const)("a commissioned bridge skips startup wait for a %s class candidate", async (candidate) => {
    const entityId = "script.clean";
    const ha = makeHa(["vacuum.a", entityId]);
    ha.states[entityId].state = "unavailable";
    const provider = makeProvider();
    const { bridge, parent, registry, online } = await make(ha, { provider });
    if (candidate === "excluded") {
      const previous = await LegacyEndpoint.create(registry, entityId);
      if (!previous) throw new Error("Script endpoint was not created");
      await parent.add(previous);
      await previous.close();
      provider.filter.exclude.push({
        type: HomeAssistantMatcherType.Pattern,
        value: entityId,
      });
    }
    provider.filter.include[1] = {
      type: HomeAssistantMatcherType.DeviceClass,
      value: "cleaning",
    };
    delete ha.states[entityId];
    const reload = vi.fn();
    Object.assign(ha, { reload });
    commission(bridge);

    await startOnFakeTimers(bridge, async () => {});

    expect(online).toEqual([["vacuum_a"]]);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ["bridge", "fresh", "unavailable"],
    ["bridge", "fresh", "unknown"],
    ["server", "reserved", "unavailable"],
  ] as const)("mounts a classless %s %s endpoint in state %s at once and follows its class", async (mode, candidate, value) => {
    const entityId = "script.clean";
    const ha = makeHa(["vacuum.a", entityId]);
    ha.entities[entityId].platform = "script";
    ha.states[entityId].state = value;
    const provider = makeProvider();
    const { bridge, parent, registry } =
      mode === "bridge"
        ? await make(ha, { provider })
        : await makeServerMode(ha, provider);
    let previous: LegacyEndpoint | undefined;
    if (candidate === "reserved") {
      previous = await LegacyEndpoint.create(
        registry,
        entityId,
        undefined,
        undefined,
        true,
      );
      if (!previous) throw new Error("Script endpoint was not created");
      await parent.add(previous);
      await previous.close();
      provider.filter.exclude.push({
        type: HomeAssistantMatcherType.AnyFieldRegex,
        value:
          "^entity_id=script\\.clean\\b(?=.*device_class=\\S)(?!.*device_class=cleaning\\b)",
      });
    } else {
      provider.filter.exclude.push({
        type: HomeAssistantMatcherType.DeviceClass,
        value: "muted",
      });
    }
    const reload = vi.fn(async () => true);
    Object.assign(ha, { reload });
    commission(bridge);
    const online: string[][] = [];
    vi.mocked(bridge.server.start).mockImplementation(async () => {
      online.push([...parent.parts].map((p) => p.id));
    });

    await startOnFakeTimers(bridge, async () => {});
    expect(online.map((ids) => ids.sort())).toEqual([
      ["script_clean", "vacuum_a"],
    ]);
    expect(reload).not.toHaveBeenCalled();
    if (previous) {
      const kept = parent.parts.find((p) => p.id === "script_clean");
      expect(kept?.number).toBe(previous.number);
    }

    ha.states[entityId].state = "off";
    ha.states[entityId].attributes.device_class = "muted";
    await bridge.refreshDevices();
    expect(parent.parts.find((p) => p.id === "script_clean")).toBeUndefined();

    ha.states[entityId].attributes.device_class = "cleaning";
    await bridge.refreshDevices();
    const mounted = parent.parts.find((p) => p.id === "script_clean");
    expect(mounted).toBeDefined();
    if (previous) expect(mounted?.number).toBe(previous.number);
  });

  it("a stop during a commissioned wait leaves no timer and no start", async () => {
    const { bridge, online } = await make(makeHa(["vacuum.a"]), {
      haRunning: false,
    });
    commission(bridge);
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(45_000);
      await bridge.stop();
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // a LAN mDNS packet can arm a matter.js expiry timer, count only ours
    await server?.close();
    server = undefined;

    expect(online).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(bridge.data.status).toBe(BridgeStatus.Stopped);
  });

  it("a commissioned bridge logs the wait each minute and gives up at 10 min", async () => {
    const { bridge, online, log } = await make(makeHa(["vacuum.a"]), {
      haRunning: false,
    });
    commission(bridge);
    const waiting = () =>
      log.info.mock.calls.filter((c) =>
        String(c[0]).startsWith("Waiting for Home Assistant data"),
      ).length;
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(online).toHaveLength(0);
      expect(waiting()).toBe(9);
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(online).toEqual([[]]);
    expect(notReady(log)).toBe(1);
  });

  it("an unpaired give up does not cut a commissioned bridge's wait", async () => {
    const { bridge, client, online, log } = await make(makeHa(["vacuum.a"]));
    await bridge.start();
    await bridge.stop();
    client.haRunning = false;
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(online).toHaveLength(2);
    await bridge.stop();
    commission(bridge);
    const starting = bridge.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(online).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 30_000 - 1);
    expect(online).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    expect(online).toHaveLength(3);
    expect(notReady(log)).toBe(2);
  });

  it("a commissioned give up spares a later commissioned bridge the wait", async () => {
    const { bridge, client, online, log } = await make(makeHa(["vacuum.a"]));
    await bridge.start();
    await bridge.stop();
    client.haRunning = false;
    commission(bridge);
    await startOnFakeTimers(bridge, async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(online).toHaveLength(2);
    await bridge.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await bridge.start();
    expect(online).toHaveLength(3);
    expect(notReady(log)).toBe(2);
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
    commission(bridge);
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

async function makeServerMode(ha: FakeHa, provider = makeProvider()) {
  const node = new ServerModeServerNode(
    makeEnvironment(ha, provider),
    provider,
  );
  server = node;
  await node.construction.ready;
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  const registry = new BridgeRegistry(ha as any, provider);
  const em = new ServerModeEndpointManager(
    node,
    // biome-ignore lint/suspicious/noExplicitAny: minimal client/registry stubs
    { haRunning: true } as any,
    registry,
    noMappings,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider,
    makeLog() as unknown as Logger,
  );
  vi.spyOn(em, "startObserving").mockResolvedValue();
  vi.spyOn(node, "start").mockResolvedValue();
  const b = Object.create(ServerModeBridge.prototype);
  Object.assign(b, {
    log: makeLog(),
    dataProvider: provider,
    server: node,
    endpointManager: em,
    status: { code: BridgeStatus.Stopped },
    lastSyncedStates: new Map(),
    sessions: fakeSessions(),
  });
  bridge = b as ServerModeBridge;
  return { bridge, parent: node, registry };
}

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
