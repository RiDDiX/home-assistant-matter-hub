import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTcpFlagBeforeStart,
  CAMERA_TCP_CONFIG,
} from "../plugins/builtin/camera/camera-tcp-requirement.js";
import { Bridge } from "../services/bridges/bridge.js";
import { createBridgeServerConfig } from "../utils/json/create-bridge-server-config.js";
import { ServerModeServerNode } from "./endpoints/server-mode-server-node.js";

// #449: the Echo advertises Matter over TCP, the bridge was UDP only unless
// cameras forced tcp on (#419). The flag opens the same listener without
// cameras.

let dir: string;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-449-tcp-"));
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function bridgeData(flags: Record<string, unknown>): BridgeData {
  return {
    id: `tcp449-${JSON.stringify(flags).length}`,
    name: "b",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: flags,
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
  } as any;
}

async function mount(
  flags: Record<string, unknown>,
  options?: { tcp?: { incoming: boolean; outgoing: boolean } },
) {
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  const config = createBridgeServerConfig(bridgeData(flags), options);
  server = await ServerNode.create({
    ...config,
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    network: { ...config.network, port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
  });
  return server;
}

// biome-ignore lint/suspicious/noExplicitAny: read network state
const tcpOf = (node: ServerNode) => (node.state.network as any).tcp;

describe("enableMatterTcp (#449)", () => {
  it("stays UDP only without the flag", async () => {
    const node = await mount({});
    expect(tcpOf(node)).toBeFalsy();
  });

  it("opens the tcp listener config with the flag on", async () => {
    const node = await mount({ enableMatterTcp: true });
    expect(tcpOf(node)).toEqual({ incoming: true, outgoing: false });
  });

  it("camera serverOptions keep precedence and survive the flag being off", async () => {
    const node = await mount({}, { tcp: { incoming: true, outgoing: true } });
    expect(tcpOf(node)).toEqual({ incoming: true, outgoing: true });
  });

  it("the server mode node gets tcp too", async () => {
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    const node = new ServerModeServerNode(
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      env as any,
      bridgeData({ enableMatterTcp: true }),
    );
    server = node;
    await node.construction.ready;
    expect(tcpOf(node)).toEqual({ incoming: true, outgoing: false });
  });
});

// A bridge restart reuses the constructed node, so the flag must also apply
// in the start path or "restart the bridge" in the schema text is a lie.
describe("flag applies on bridge start, not only at creation (#449)", () => {
  it("enables tcp on a kept node when the flag turned on", async () => {
    const set = vi.fn();
    const server = { state: { network: {} }, set };
    await applyTcpFlagBeforeStart(server, { enableMatterTcp: true });
    expect(set).toHaveBeenCalledWith({ network: { tcp: CAMERA_TCP_CONFIG } });
  });

  it("leaves an already enabled listener alone", async () => {
    const set = vi.fn();
    const server = { state: { network: { tcp: CAMERA_TCP_CONFIG } }, set };
    await applyTcpFlagBeforeStart(server, { enableMatterTcp: true });
    expect(set).not.toHaveBeenCalled();
  });

  it("never disables, that path is documented as a matterhub restart", async () => {
    const set = vi.fn();
    const server = { state: { network: { tcp: CAMERA_TCP_CONFIG } }, set };
    await applyTcpFlagBeforeStart(server, {});
    expect(set).not.toHaveBeenCalled();
  });
});

describe("camera config save respects the flag (#449)", () => {
  function fakeBridge(flags: Record<string, unknown>) {
    const set = vi.fn();
    const self = {
      dataProvider: { featureFlags: flags },
      server: { state: { network: { tcp: CAMERA_TCP_CONFIG } }, set },
      status: { code: "stopped" },
      log: { info: vi.fn(), warn: vi.fn() },
      stop: vi.fn(),
      start: vi.fn(),
    };
    return { self, set };
  }

  it("keeps tcp when the flag is on and the camera list empties", async () => {
    const { self, set } = fakeBridge({ enableMatterTcp: true });
    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    await (Bridge.prototype as any).applyCameraTcp.call(self, { cameras: "" });
    expect(set).not.toHaveBeenCalled();
  });

  it("still drops tcp when the flag is off and the camera list empties", async () => {
    const { self, set } = fakeBridge({});
    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    await (Bridge.prototype as any).applyCameraTcp.call(self, { cameras: "" });
    expect(set).toHaveBeenCalledWith({ network: { tcp: undefined } });
  });
});
