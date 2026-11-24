import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeData,
  BridgeStatus,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import type { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import { BridgeServerNode } from "../../matter/endpoints/bridge-server-node.js";
import { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { Bridge } from "./bridge.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { ServerModeBridge } from "./server-mode-bridge.js";

// A port edit only reached BridgeData. The ServerNode binds network.port from
// its constructor config on every start, so the bridge kept the old port until
// the add-on restarted.

// both held open while picked, so the two can never be the same port
async function freePorts(): Promise<[number, number]> {
  const socks = [0, 1].map(() =>
    dgram.createSocket({ type: "udp6", ipv6Only: false }),
  );
  await Promise.all(socks.map((s) => new Promise<void>((r) => s.bind(0, r))));
  const ports = socks.map((s) => s.address().port);
  await Promise.all(
    socks.map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  return [ports[0], ports[1]];
}

async function inUse(port: number): Promise<boolean> {
  const s = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.bind(port, resolve);
    });
    return false;
  } catch {
    return true;
  } finally {
    s.close();
  }
}

let dir: string;
let server: ServerNode | undefined;
let bridge: Bridge | undefined;
let blocker: dgram.Socket | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-port-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await bridge?.stop().catch(() => {});
  await server?.close().catch(() => {});
  blocker?.close();
  bridge = server = blocker = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const modes = {
  bridge: {
    node: (
      env: Environment,
      data: BridgeDataProvider,
      agg: AggregatorEndpoint,
    ) =>
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      new BridgeServerNode(env as any, data, agg),
    proto: Bridge.prototype,
  },
  "server mode": {
    node: (env: Environment, data: BridgeDataProvider) =>
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      new ServerModeServerNode(env as any, data),
    proto: ServerModeBridge.prototype,
  },
};

describe.each(Object.entries(modes))("port edit, %s", (_, mode) => {
  async function make(port: number) {
    const data = {
      id: "port-bridge",
      name: "p",
      port,
      filter: { include: [], exclude: [], includeMode: "any" },
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
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    const dataProvider = new BridgeDataProvider(data);
    const aggregator = new AggregatorEndpoint("aggregator");
    const node = mode.node(env, dataProvider, aggregator);
    server = node;
    await node.construction.ready;
    // the real constructors build a full BridgeEnvironment, fake the rest
    const b = Object.create(mode.proto);
    const noop = async () => {};
    Object.assign(b, {
      log: { debug() {}, debugCtx() {}, info() {}, warn() {}, error() {} },
      dataProvider,
      server: node,
      status: { code: BridgeStatus.Stopped },
      lastSyncedStates: new Map(),
      autoForceSyncTimer: null,
      warmStartTimer: null,
      sessions: {
        start() {},
        stop() {},
        reconfigure() {},
        closeActiveSessions: noop,
      },
      endpointManager: {
        root: aggregator,
        devices: [],
        refreshDevices: noop,
        startObserving: noop,
        stopObserving() {},
        startPlugins: noop,
        stopPlugins: noop,
      },
    });
    bridge = b as Bridge;
    const update = (p: number, name = data.name) => ({
      id: data.id,
      name,
      port: p,
      filter: data.filter,
    });
    return {
      bridge: b as Bridge,
      node,
      update,
      sessions: b.sessions,
      activeTimers: () =>
        [
          b.autoForceSyncTimer,
          b.commissioningCheckTimer,
          b.warmStartTimer,
        ].filter(Boolean),
    };
  }

  it("rebinds a running bridge on the new port", async () => {
    const [a, b] = await freePorts();
    const { bridge, node, update } = await make(a);
    await bridge.start();
    expect(node.state.network.operationalPort).toBe(a);

    await bridge.update(update(b));

    expect(bridge.data.status).toBe(BridgeStatus.Running);
    expect(node.state.network.operationalPort).toBe(b);
    expect(await inUse(b)).toBe(true);
    expect(await inUse(a)).toBe(false);
  });

  it("binds the new port on the next start of a stopped bridge", async () => {
    const [a, b] = await freePorts();
    const { bridge, node, update } = await make(a);
    await bridge.start();
    await bridge.stop();

    await bridge.update(update(b));
    expect(bridge.data.status).toBe(BridgeStatus.Stopped);
    await bridge.start();

    expect(node.state.network.operationalPort).toBe(b);
    expect(await inUse(a)).toBe(false);
  });

  it("restarts a bridge that failed on a taken port once the port is fixed", async () => {
    const [a, b] = await freePorts();
    blocker = dgram.createSocket({ type: "udp6", ipv6Only: false });
    await new Promise<void>((r) => blocker?.bind(a, r));
    const { bridge, node, update } = await make(a);
    await bridge.start();
    expect(bridge.data.status).toBe(BridgeStatus.Failed);

    await bridge.update(update(b));

    expect(bridge.data.status).toBe(BridgeStatus.Running);
    expect(node.state.network.operationalPort).toBe(b);
  });

  it("a stop issued during start waits for it and ends stopped", async () => {
    const [a] = await freePorts();
    const { bridge } = await make(a);

    const starting = bridge.start();
    await bridge.stop();
    await starting;

    expect(bridge.data.status).toBe(BridgeStatus.Stopped);
    expect(await inUse(a)).toBe(false);
  });

  it.each([
    "node start",
    "node error",
    "post-start hook",
  ])("preserves a timed-out stop after a delayed %s", async (delayed) => {
    const [port] = await freePorts();
    const { bridge, node, sessions, activeTimers } = await make(port);
    const sessionStart = vi.spyOn(sessions, "start");
    const statuses: BridgeStatus[] = [];
    bridge.onStatusChange = () => statuses.push(bridge.data.status);
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nodeStart = node.start.bind(node);
    const hooks = bridge as unknown as { onServerStarted(): Promise<void> };
    const onStarted = hooks.onServerStarted.bind(bridge);
    const hook = vi.spyOn(hooks, "onServerStarted");
    if (delayed === "post-start hook") {
      hook.mockImplementationOnce(async () => {
        markEntered();
        await released;
        await onStarted();
      });
    } else {
      vi.spyOn(node, "start").mockImplementationOnce(async () => {
        markEntered();
        await released;
        if (delayed === "node error") throw new Error("late start failure");
        await nodeStart();
      });
    }

    const starting = bridge.start();
    await entered;
    vi.useFakeTimers();
    const stopping = bridge.stop(BridgeStatus.Stopped, "Requested stop");
    await vi.advanceTimersByTimeAsync(60_000);
    await stopping;
    vi.useRealTimers();
    expect(bridge.data.statusReason).toBe("Requested stop");

    const cancel = vi.spyOn(node, "cancel");
    const restarting = delayed === "node start" ? bridge.start() : undefined;
    release();
    await starting;
    expect(cancel).toHaveBeenCalledOnce();
    expect(statuses.slice(0, 2)).toEqual([
      BridgeStatus.Starting,
      BridgeStatus.Stopped,
    ]);
    if (!restarting) {
      expect(bridge.data.status).toBe(BridgeStatus.Stopped);
      expect(bridge.data.statusReason).toBe("Requested stop");
      expect(sessionStart).not.toHaveBeenCalled();
      expect(activeTimers()).toEqual([]);
      expect(await inUse(port)).toBe(false);
    } else {
      expect(hook).toHaveBeenCalledTimes(0);
    }

    await (restarting ?? bridge.start());
    expect(statuses).toEqual([
      BridgeStatus.Starting,
      BridgeStatus.Stopped,
      BridgeStatus.Starting,
      BridgeStatus.Running,
    ]);
    expect(sessionStart).toHaveBeenCalledOnce();
    expect(await inUse(port)).toBe(true);
  });

  it("a port edit issued during start ends on the new port", async () => {
    const [a, b] = await freePorts();
    const { bridge, node, update } = await make(a);
    // hold the edit until the start has already bound the old port
    const nodeStart = node.start.bind(node);
    let bound!: () => void;
    const onOldPort = new Promise<void>((r) => (bound = r));
    node.start = async () => {
      await nodeStart();
      bound();
    };

    const starting = bridge.start();
    await onOldPort;
    expect(bridge.data.status).toBe(BridgeStatus.Starting);
    await bridge.update(update(b));
    await starting;

    expect(bridge.data.status).toBe(BridgeStatus.Running);
    expect(node.state.network.operationalPort).toBe(b);
    expect(await inUse(a)).toBe(false);
  });

  it("does not restart for an edit that keeps the port", async () => {
    const [a] = await freePorts();
    const { bridge, node, update } = await make(a);
    await bridge.start();
    const cancel = node.cancel.bind(node);
    let cancels = 0;
    node.cancel = async () => {
      cancels++;
      await cancel();
    };

    await bridge.update(update(a, "renamed"));

    expect(cancels).toBe(0);
    expect(bridge.data.status).toBe(BridgeStatus.Running);
    expect(bridge.data.name).toBe("renamed");
  });
});
