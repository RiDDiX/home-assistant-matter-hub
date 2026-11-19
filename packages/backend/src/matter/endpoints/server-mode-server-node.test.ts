import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerModeServerNode } from "./server-mode-server-node.js";

const bridgeData = {
  id: "sm-node",
  name: "sm-node",
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
let node: ServerModeServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-sm-node-"));
});

afterEach(async () => {
  await node?.close().catch(() => {});
  node = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("ServerModeServerNode.addDevice", () => {
  it("mounts a retried device after a failed add", async () => {
    const env = new Environment("sm-node", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    node = new ServerModeServerNode(env, bridgeData);
    await node.construction.ready;
    const add = vi
      .spyOn(node, "add")
      .mockRejectedValueOnce(new Error("Behaviors have errors"));

    await expect(
      node.addDevice(new Endpoint(OnOffPlugInUnitDevice, { id: "plug" })),
    ).rejects.toThrow("Behaviors have errors");
    expect(node.deviceCount).toBe(0);

    const retry = new Endpoint(OnOffPlugInUnitDevice, { id: "plug" });
    await node.addDevice(retry);
    expect(add).toHaveBeenCalledTimes(2);
    expect(node.deviceCount).toBe(1);
    expect(node.parts.has(retry)).toBe(true);
  });
});
