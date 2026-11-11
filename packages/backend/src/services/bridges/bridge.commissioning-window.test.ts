import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeData,
  BridgeStatus,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { AdministratorCommissioning } from "@matter/main/clusters";
import { CommissioningServer, type ServerNode } from "@matter/main/node";
import { DeviceCommissioner, FabricManager } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import { BridgeServerNode } from "../../matter/endpoints/bridge-server-node.js";
import { Bridge } from "./bridge.js";
import { COMMISSIONING_CHECK_MS } from "./bridge-base.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";

// matter.js closes the window an uncommissioned node opens itself after 48 h
// and nothing reopens it, while the UI keeps showing the pairing code.
// endCommissioning stands in for that expiry.

async function freePort(): Promise<number> {
  const s = dgram.createSocket({ type: "udp6", ipv6Only: false });
  await new Promise<void>((r) => s.bind(0, r));
  const { port } = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let dir: string;
let server: ServerNode | undefined;
let bridge: Bridge | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-window-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await bridge?.stop().catch(() => {});
  await server?.close().catch(() => {});
  bridge = server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function make() {
  const data = {
    id: "window-bridge",
    name: "w",
    port: await freePort(),
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
  // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
  const node = new BridgeServerNode(env as any, dataProvider, aggregator);
  server = node;
  await node.construction.ready;
  // the real constructors build a full BridgeEnvironment, fake the rest
  const b = Object.create(Bridge.prototype);
  const noop = async () => {};
  const info = vi.fn();
  Object.assign(b, {
    log: { debug() {}, debugCtx() {}, info, warn() {}, error() {} },
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
      startObserving() {},
      stopObserving() {},
      startPlugins: noop,
      stopPlugins: noop,
    },
  });
  bridge = b as Bridge;
  const windowOpen = () =>
    node.env.get(DeviceCommissioner).windowStatus !==
    AdministratorCommissioning.CommissioningWindowStatus.WindowNotOpen;
  return { bridge: b as Bridge, node, info, windowOpen };
}

describe("commissioning window of a running bridge", () => {
  it("reopens the expired window of an uncommissioned bridge", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { bridge, node, info, windowOpen } = await make();
    await bridge.start();
    await vi.waitFor(() => expect(windowOpen()).toBe(true));
    await node.env.get(DeviceCommissioner).endCommissioning();
    expect(windowOpen()).toBe(false);

    await vi.advanceTimersByTimeAsync(COMMISSIONING_CHECK_MS);

    await vi.waitFor(() => expect(windowOpen()).toBe(true));
    expect(info).toHaveBeenCalledWith(
      "Commissioning window expired before pairing, reopened it",
    );
  });

  // commissioned: a paired bridge; not yet: CommissioningComplete closed the
  // window and the fabric exists, but the flag is set only afterwards
  it.each([
    true,
    false,
  ])("leaves the window closed while a fabric exists, commissioned %s", async (commissioned) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { bridge, node, windowOpen } = await make();
    await bridge.start();
    await vi.waitFor(() => expect(windowOpen()).toBe(true));
    vi.spyOn(node.env.get(FabricManager), "length", "get").mockReturnValue(1);
    await node.setStateOf(CommissioningServer, { commissioned });
    await node.env.get(DeviceCommissioner).endCommissioning();
    const act = vi.spyOn(node, "act");

    await vi.advanceTimersByTimeAsync(COMMISSIONING_CHECK_MS);

    expect(act).not.toHaveBeenCalled();
    expect(windowOpen()).toBe(false);
  });
});
