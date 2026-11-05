import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, Logger, VariableService } from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { FabricManager } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AggregatorEndpoint } from "./aggregator-endpoint.js";
import { BridgeServerNode } from "./bridge-server-node.js";
import { ServerModeServerNode } from "./server-mode-server-node.js";

// #541: a factory reset while a controller held the failsafe armed (AddNOC
// done, no CommissioningComplete yet) rolled the failsafe back against the
// erased node and logged "Datasource not yet initialized".

let dir: string;
let counter = 0;
let logs: string[];
let restoreLog: () => void;
const nodes: ServerNode[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-541-"));
  logs = [];
  const dest = Logger.destinations.default;
  const orig = dest.write;
  dest.write = (text: string) => {
    logs.push(text);
  };
  restoreLog = () => {
    dest.write = orig;
  };
});

afterEach(async () => {
  restoreLog();
  for (const node of nodes.splice(0).reverse()) {
    await node.close().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

const data = {
  id: "e57533d4a89349f6889f78795043b92a",
  name: "b",
  port: 0,
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
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
} as any as BridgeData;

function env() {
  const e = new Environment("test", Environment.default);
  e.get(VariableService).set("storage.path", dir);
  // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
  return e as any;
}

async function controllerFor(device: ServerNode) {
  // biome-ignore lint/suspicious/noExplicitAny: runtime state
  const { commissioning, network } = device.state as any;
  const controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      environment: env(),
      id: `541-controller-${counter}`,
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
    deviceIdentifier: `541-${counter++}`,
    D: commissioning.discriminator,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
  const commission = (finalizeCommissioning?: () => Promise<void>) =>
    client.commission({
      passcode: commissioning.passcode,
      discriminator: commissioning.discriminator,
      autoSubscribe: false,
      autoStateInitialize: false,
      finalizeCommissioning,
    });
  return { controller, commission };
}

const modes = {
  bridge: () =>
    new BridgeServerNode(env(), data, new AggregatorEndpoint("aggregator")),
  "server mode": () => new ServerModeServerNode(env(), data),
};

describe.each(Object.entries(modes))("factory reset, %s (#541)", (_, make) => {
  it("rolls an armed failsafe back before erasing", async () => {
    const device = make();
    nodes.push(device);
    await device.start();

    const first = await controllerFor(device);
    let reset!: () => void;
    const resetDone = new Promise<void>((r) => {
      reset = r;
    });
    const aborted = expect(
      first.commission(async () => {
        // Bridge.factoryReset stops (cancels) the node before resetting it.
        await device.cancel();
        await device.factoryReset();
        reset();
        throw new Error("commissioning aborted by test");
      }),
    ).rejects.toThrow();
    await resetDone;
    // otherwise it retries the reset device for about 13 s
    await first.controller.close();
    await aborted;

    expect(
      logs.filter((l) => /Datasource not yet initialized|Illegal/.test(l)),
    ).toEqual([]);
    expect(device.env.get(FabricManager).fabrics).toHaveLength(0);
    expect(device.state.commissioning.commissioned).toBe(false);

    await device.start();
    await (await controllerFor(device)).commission();
    expect(device.state.commissioning.commissioned).toBe(true);
    expect(device.env.get(FabricManager).fabrics).toHaveLength(1);
  }, 30_000);
});
