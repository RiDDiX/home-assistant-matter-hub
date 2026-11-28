import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeServerConfig } from "../../utils/json/create-bridge-server-config.js";
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

// The Aqara ids are for Apple's Adaptive Temperature allowlist only, every
// other bridge keeps the HAMH vendor and product id.
describe("ServerModeServerNode identity", () => {
  it.each([
    ["plain server mode", { serverMode: true }, 0xfff1, 0x8000],
    ["no flags", {}, 0xfff1, 0x8000],
    [
      "adaptive turned off",
      { serverMode: false, appleAdaptiveTemperature: false },
      0xfff1,
      0x8000,
    ],
    ["adaptive", { appleAdaptiveTemperature: true }, 0x115f, 0x4801],
  ])("%s", async (_, featureFlags, vendorId, productId) => {
    const env = new Environment("sm-node", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    node = new ServerModeServerNode(env, { ...bridgeData, featureFlags });
    await node.construction.ready;
    // biome-ignore lint/suspicious/noExplicitAny: read root cluster state
    const info = (node.state as any).basicInformation;
    expect(info.vendorId).toBe(vendorId);
    expect(info.productId).toBe(productId);
    // names stay the bridge's own, only the ids change
    expect(info.vendorName).toBe("t");
    expect(info.productName).toBe("t");
  });

  it("keeps the HAMH ids on an aggregator bridge", () => {
    const config = createBridgeServerConfig({
      ...bridgeData,
      featureFlags: { appleAdaptiveTemperature: true },
    });
    expect(config.basicInformation?.vendorId).toBe(0xfff1);
    expect(config.basicInformation?.productId).toBe(0x8000);
  });
});
