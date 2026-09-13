import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeServerConfig } from "../utils/json/create-bridge-server-config.js";
import { ServerModeServerNode } from "./endpoints/server-mode-server-node.js";
import { rootEndpointType } from "./tc-general-commissioning.js";

// #449: Alexa sends SetTcAcknowledgements during pairing and the default
// GeneralCommissioning server rejects it as unsupported. With the flag on the
// root node carries the TermsAndConditions feature and accepts the command.

let dir: string;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-449-tc-"));
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function bridgeData(flags: Record<string, unknown>): BridgeData {
  return {
    id: `tc449-${JSON.stringify(flags).length}`,
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

async function mount(flags: Record<string, unknown>) {
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  const config = createBridgeServerConfig(bridgeData(flags));
  server = await ServerNode.create({
    ...config,
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
  });
  return server;
}

// biome-ignore lint/suspicious/noExplicitAny: reach into cluster state
const gc = (node: ServerNode) => (node.state as any).generalCommissioning;

describe("supportTermsAndConditions (#449)", () => {
  it("picks the plain commissioning server with the flag off", () => {
    const plain = ServerNode.RootEndpoint.behaviors.generalCommissioning;
    expect(rootEndpointType({}).behaviors.generalCommissioning).toBe(plain);
    expect(rootEndpointType(undefined).behaviors.generalCommissioning).toBe(
      plain,
    );
    expect(
      rootEndpointType({ supportTermsAndConditions: true }).behaviors
        .generalCommissioning,
    ).not.toBe(plain);
  });

  it("keeps TC off the wire without the flag", async () => {
    const node = await mount({});
    expect(gc(node).featureMap.termsAndConditions).toBeFalsy();
    expect(gc(node).tcAcknowledgementsRequired).toBeUndefined();
    expect(gc(node).acceptedCommandList).not.toContain(0x6);
  });

  it("advertises the feature and the safe defaults with the flag on", async () => {
    const node = await mount({ supportTermsAndConditions: true });
    expect(gc(node).featureMap.termsAndConditions).toBe(true);
    // command 0x6 must register at the interaction layer, the field failure
    // was the dispatcher skipping it, not the behavior
    expect(gc(node).acceptedCommandList).toContain(0x6);
    expect(gc(node).tcAcceptedVersion).toBe(0);
    expect(gc(node).tcMinRequiredVersion).toBe(0);
    expect(gc(node).tcAcknowledgements).toEqual({});
    expect(gc(node).tcAcknowledgementsRequired).toBe(false);
    expect(gc(node).tcUpdateDeadline).toBeNull();
  });

  it("accepts SetTcAcknowledgements and stores the acknowledgement", async () => {
    const node = await mount({ supportTermsAndConditions: true });
    const response = await node.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (agent as any).generalCommissioning.setTcAcknowledgements({
        tcVersion: 3,
        tcUserResponse: 1,
      }),
    );
    expect(response).toEqual({ errorCode: 0 });
    expect(gc(node).tcAcceptedVersion).toBe(3);
    // the response map is deliberately not stored, see the server comment
    expect(gc(node).tcAcknowledgements).toEqual({});
  });

  it("survives a flag toggle on kept storage, both directions", async () => {
    const data = bridgeData({});
    const on = { ...data, featureFlags: { supportTermsAndConditions: true } };

    async function remount(bridge: BridgeData) {
      await server?.close();
      const env = new Environment("test", Environment.default);
      env.get(VariableService).set("storage.path", dir);
      server = await ServerNode.create({
        ...createBridgeServerConfig(bridge),
        // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
        environment: env as any,
        network: { port: 0 },
        commissioning: { passcode: 20202021, discriminator: 3840 },
      });
      return server;
    }

    let node = await remount(on);
    expect(gc(node).featureMap.termsAndConditions).toBe(true);
    // leave persisted TC state behind so the off-mount meets it in storage
    await node.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (agent as any).generalCommissioning.setTcAcknowledgements({
        tcVersion: 3,
        tcUserResponse: 1,
      }),
    );
    expect(gc(node).tcAcceptedVersion).toBe(3);

    node = await remount(data);
    expect(gc(node).featureMap.termsAndConditions).toBeFalsy();

    node = await remount(on);
    expect(gc(node).featureMap.termsAndConditions).toBe(true);
    expect(gc(node).tcAcknowledgementsRequired).toBe(false);
    expect(gc(node).tcAcceptedVersion).toBe(3);
  });

  it("the server mode node gets the feature too", async () => {
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    const node = new ServerModeServerNode(
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      env as any,
      bridgeData({ supportTermsAndConditions: true }),
    );
    server = node;
    await node.construction.ready;
    expect(gc(node).featureMap.termsAndConditions).toBe(true);
  });
});
