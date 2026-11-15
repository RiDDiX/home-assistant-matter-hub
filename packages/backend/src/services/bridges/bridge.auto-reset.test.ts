import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeStatus } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import {
  BasicInformationServer,
  OperationalCredentialsClient,
} from "@matter/main/behaviors";
import { ServerNode } from "@matter/main/node";
import { FabricManager } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoggerService } from "../../core/app/logger.js";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { Bridge } from "./bridge.js";
import {
  BridgeDataProvider,
  type BridgeServerStatus,
} from "./bridge-data-provider.js";
import type { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { ServerModeBridge } from "./server-mode-bridge.js";
import type { ServerModeEndpointManager } from "./server-mode-endpoint-manager.js";

// matter.js erases an online node itself once the last fabric is gone and
// re-binds the port inside erase. A port taken meanwhile crashed the runtime
// and left the process without its web server.

let dir: string;
let counter = 0;
const nodes: ServerNode[] = [];
const sockets: dgram.Socket[] = [];
const bridges: (Bridge | ServerModeBridge)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-auto-reset-"));
});

afterEach(async () => {
  // a running bridge keeps its commissioning check and session timers
  for (const bridge of bridges.splice(0)) {
    await bridge.stop().catch(() => {});
  }
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const node of nodes.splice(0).reverse()) {
    await node.close().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

function env() {
  const e = new Environment("test", Environment.default);
  e.get(VariableService).set("storage.path", dir);
  // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
  return e as any;
}

function provider(port: number) {
  return new BridgeDataProvider({
    id: "e57533d4a89349f6889f78795043b92a",
    name: "b",
    port,
    filter: { include: [], exclude: [] },
    featureFlags: {},
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "t",
      productId: 0x8000,
      productName: "t",
      productLabel: "t",
      hardwareVersion: 1,
      softwareVersion: 1,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any);
}

const log = {
  debug: vi.fn(),
  debugCtx: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const logger = { get: () => log } as unknown as LoggerService;

function endpointManager() {
  return {
    root: new AggregatorEndpoint("aggregator"),
    devices: [],
    failedEntities: [],
    refreshDeferred: false,
    setTopologyChangeHandler() {},
    refreshDevices: async () => true,
    startObserving: async () => {},
    stopObserving() {},
    startPlugins: async () => {},
    stopPlugins: async () => {},
  };
}

const modes = {
  bridge: (port: number) =>
    new Bridge(
      env(),
      logger,
      provider(port),
      endpointManager() as unknown as BridgeEndpointManager,
    ),
  "server mode": (port: number) => {
    const data = provider(port);
    return new ServerModeBridge(
      logger,
      data,
      endpointManager() as unknown as ServerModeEndpointManager,
      new ServerModeServerNode(env(), data),
    );
  },
};

function bindForeign(port: number) {
  return new Promise<dgram.Socket>((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp6", ipv6Only: false });
    socket.once("error", reject);
    socket.bind(port, "::", () => {
      sockets.push(socket);
      resolve(socket);
    });
  });
}

async function commission(device: ServerNode) {
  // biome-ignore lint/suspicious/noExplicitAny: runtime state
  const { commissioning, network } = device.state as any;
  const controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      environment: env(),
      id: `auto-reset-controller-${counter}`,
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  nodes.push(controller);
  await controller.start();
  const client = await controller.peers.forDescriptor({
    addresses: [
      { type: "udp", ip: "127.0.0.1", port: network.operationalPort },
    ],
    deviceIdentifier: `auto-reset-${counter++}`,
    D: commissioning.discriminator,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
  await client.commission({
    passcode: commissioning.passcode,
    discriminator: commissioning.discriminator,
    autoSubscribe: false,
    autoStateInitialize: true,
  });
  return client;
}

async function until(check: () => boolean, ms = 8000) {
  const since = Date.now();
  while (!check() && Date.now() - since < ms) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.each(
  Object.entries(modes).map(([name, make], i) => [name, make, 55720 + i * 4]),
)("auto factory reset, %s", (_, make, base) => {
  const port = base as number;
  const create = make as (port: number) => Bridge | ServerModeBridge;

  it("survives a port taken while the node is offline", async () => {
    const bridge = create(port);
    bridges.push(bridge);
    nodes.push(bridge.server);
    await bridge.server.construction;
    await bridge.start();
    expect(bridge.data.status).toBe(BridgeStatus.Running);
    // taken between the offline erase and the restart, not raced
    const reset = bridge.server.factoryReset.bind(bridge.server);
    let taken: dgram.Socket | undefined;
    bridge.server.factoryReset = async () => {
      await reset();
      taken = await bindForeign(port);
    };

    try {
      await expect(bridge.server.erase()).resolves.toBeUndefined();
      expect(taken).toBeDefined();
      expect(bridge.server.construction.status).not.toBe("crashed");
      expect(bridge.data.status).toBe(BridgeStatus.Failed);
    } finally {
      if (taken) {
        sockets.splice(sockets.indexOf(taken), 1);
        await new Promise<void>((resolve) => taken?.close(() => resolve()));
      }
    }
    await bridge.start();
    expect(bridge.data.status).toBe(BridgeStatus.Running);
    expect(bridge.server.state.network.port).toBe(port);
  }, 30_000);

  it("renews the root unique id when the last fabric is removed", async () => {
    const bridge = create(port + 1);
    bridges.push(bridge);
    nodes.push(bridge.server);
    await bridge.server.construction;
    await bridge.start();
    const before = bridge.server.stateOf(BasicInformationServer).uniqueId;
    const client = await commission(bridge.server);
    const [fabric] = bridge.server.env.get(FabricManager).fabrics;
    // node state is unreadable mid erase, the bridge status is not
    const seen: BridgeStatus[] = [];
    bridge.onStatusChange = () => {
      seen.push(
        (bridge as unknown as { status: BridgeServerStatus }).status.code,
      );
    };

    // the answer may not arrive, the node drops the session it came over
    await Promise.resolve(
      client.act((agent) =>
        agent
          .get(OperationalCredentialsClient)
          .removeFabric({ fabricIndex: fabric.fabricIndex }),
      ),
    ).catch(() => {});
    await until(
      () =>
        seen.includes(BridgeStatus.Stopped) &&
        seen.at(-1) === BridgeStatus.Running,
    );

    expect(bridge.server.env.get(FabricManager).fabrics).toHaveLength(0);
    expect(bridge.server.stateOf(BasicInformationServer).uniqueId).not.toBe(
      before,
    );
    expect(bridge.data.status).toBe(BridgeStatus.Running);
    expect(bridge.server.lifecycle.isOnline).toBe(true);
  }, 60_000);

  it("stays stopped when a stop arrives during the reset", async () => {
    const bridge = create(port + 2);
    bridges.push(bridge);
    nodes.push(bridge.server);
    await bridge.server.construction;
    await bridge.start();
    const reset = bridge.server.factoryReset.bind(bridge.server);
    let calls = 0;
    bridge.server.factoryReset = async () => {
      calls++;
      await reset();
      await bridge.stop();
    };

    // matter.js reacts to closed sessions again, the second erase joins
    await Promise.all([bridge.server.erase(), bridge.server.erase()]);

    expect(calls).toBe(1);
    expect(bridge.data.status).toBe(BridgeStatus.Stopped);
    expect(bridge.server.lifecycle.isOnline).toBe(false);
  }, 30_000);

  it("is not started again when deleted during the reset", async () => {
    const bridge = create(port + 3);
    bridges.push(bridge);
    nodes.push(bridge.server);
    await bridge.server.construction;
    await bridge.start();
    const reset = bridge.server.factoryReset.bind(bridge.server);
    const start = vi.spyOn(bridge, "start");
    let calls = 0;
    bridge.server.factoryReset = async () => {
      calls++;
      await reset();
      await bridge.stop();
      await bridge.delete();
    };

    await bridge.server.erase();

    expect(calls).toBe(1);
    expect(start).not.toHaveBeenCalled();
    expect(bridge.server.construction.status).toBe("destroyed");
  }, 30_000);
});
