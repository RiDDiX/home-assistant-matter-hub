import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import type { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AggregatorEndpoint } from "./aggregator-endpoint.js";
import { BridgeServerNode } from "./bridge-server-node.js";
import { ServerModeServerNode } from "./server-mode-server-node.js";

// #530: the root UniqueID was the bridge id and survived a factory reset, so
// Alexa kept matching a re-paired bridge to the device the user had deleted.
// The spec wants a new UniqueID after a factory reset.

const ID = "e57533d4a89349f6889f78795043b92a";

let dir: string;
let node: (ServerNode & { factoryReset(): Promise<void> }) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-530-"));
});

afterEach(async () => {
  await node?.close().catch(() => {});
  node = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const data = {
  id: ID,
  name: "b",
  port: 0,
  filter: { include: [], exclude: [], includeMode: "any" },
  uniqueIdSuffix: "x",
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

const modes = {
  bridge: () =>
    new BridgeServerNode(env(), data, new AggregatorEndpoint("aggregator")),
  "server mode": () => new ServerModeServerNode(env(), data),
};

describe.each(Object.entries(modes))("root UniqueID, %s (#530)", (_, make) => {
  async function mount() {
    await node?.close();
    node = make();
    await node.construction.ready;
    return node.state.basicInformation.uniqueId;
  }

  it("stays the bridge id until a factory reset, the suffix does not touch it", async () => {
    expect(await mount()).toBe(ID);
    expect(await mount()).toBe(ID);
  });

  it("gets a new id on factory reset that survives a restart", async () => {
    await mount();
    await node?.factoryReset();
    const renewed = node?.state.basicInformation.uniqueId;
    expect(renewed).not.toBe(ID);
    expect(renewed).toHaveLength(32);

    expect(await mount()).toBe(renewed);

    await node?.factoryReset();
    const again = node?.state.basicInformation.uniqueId;
    expect(again).not.toBe(renewed);
    expect(again).not.toBe(ID);
  });
});
