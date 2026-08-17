import { describe, expect, it, vi } from "vitest";
import {
  applyLegacySpecSessionParameters,
  DATA_MODEL_REVISION_19,
  legacySpecBasicInformation,
  SPEC_VERSION_1_5_1,
  specVersionValues,
} from "./legacy-spec-version.js";

// #449: opt-in diagnostic, the bridge reports Matter 1.5.1 the way 2.0.49
// did, in the attributes and the session parameters both. Half a mask would
// be a worse lie than none.

describe("advertiseSpecVersion151 (#449)", () => {
  it("restores the true values when off, a kept node must not stay masked", () => {
    expect(legacySpecBasicInformation(undefined)).toEqual({});
    expect(legacySpecBasicInformation({})).toEqual({});

    const setter = vi.fn();
    const sessionManager = {};
    Object.defineProperty(sessionManager, "sessionParameters", { set: setter });
    // biome-ignore lint/suspicious/noExplicitAny: session manager stub
    applyLegacySpecSessionParameters(sessionManager as any, {});
    expect(setter).toHaveBeenCalledWith({
      specificationVersion: 17170432,
      dataModelRevision: 21,
    });
  });

  it("masks the attributes and the session parameters together", () => {
    const flags = { advertiseSpecVersion151: true };
    expect(legacySpecBasicInformation(flags)).toEqual({
      specificationVersion: SPEC_VERSION_1_5_1,
      dataModelRevision: DATA_MODEL_REVISION_19,
    });

    const setter = vi.fn();
    const sessionManager = {};
    Object.defineProperty(sessionManager, "sessionParameters", { set: setter });
    // biome-ignore lint/suspicious/noExplicitAny: session manager stub
    applyLegacySpecSessionParameters(sessionManager as any, flags);
    expect(setter).toHaveBeenCalledWith({
      specificationVersion: SPEC_VERSION_1_5_1,
      dataModelRevision: DATA_MODEL_REVISION_19,
    });
  });

  it("uses the exact values 2.0.49 shipped", () => {
    // @matter/model 0.17.3: REVISION 1.5.1, spec 17105152, DM 19
    expect(SPEC_VERSION_1_5_1).toBe(17105152);
    expect(DATA_MODEL_REVISION_19).toBe(19);
  });
});

// End to end: the config spread has to win over matter.js's own defaults on a
// real node, or the mask never reaches the wire.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { BasicInformationServer } from "@matter/main/behaviors";
import { ServerNode } from "@matter/main/node";
import { SessionManager } from "@matter/main/protocol";
import { afterEach, beforeEach } from "vitest";
import { ServerModeServerNode } from "./endpoints/server-mode-server-node.js";
import { createBridgeServerConfig } from "../utils/json/create-bridge-server-config.js";

let dir: string;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-449-"));
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function bridgeData(flags: Record<string, unknown>): BridgeData {
  return {
    id: `spec449-${Math.abs(JSON.stringify(flags).length)}`,
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

describe("the mask reaches the root node attributes (#449)", () => {
  it("reports 1.5.1 and DM 19 with the flag on", async () => {
    const node = await mount({ advertiseSpecVersion151: true });
    expect(node.state.basicInformation.specificationVersion).toBe(17105152);
    expect(node.state.basicInformation.dataModelRevision).toBe(19);
  });

  it("keeps the matter.js values with the flag off", async () => {
    const node = await mount({});
    expect(node.state.basicInformation.specificationVersion).toBe(17170432);
    expect(node.state.basicInformation.dataModelRevision).toBe(21);
  });

  it("a kept node follows the flag through setStateOf, both directions", async () => {
    const node = await mount({ advertiseSpecVersion151: true });
    expect(node.state.basicInformation.specificationVersion).toBe(17105152);

    // flag turned off later, same node: the bridge start path re-applies
    await node.setStateOf(BasicInformationServer, specVersionValues({}));
    expect(node.state.basicInformation.specificationVersion).toBe(17170432);
    expect(node.state.basicInformation.dataModelRevision).toBe(21);

    await node.setStateOf(
      BasicInformationServer,
      specVersionValues({ advertiseSpecVersion151: true }),
    );
    expect(node.state.basicInformation.specificationVersion).toBe(17105152);
    expect(node.state.basicInformation.dataModelRevision).toBe(19);
  });

  it("the server mode node gets the mask too", async () => {
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    const node = new ServerModeServerNode(
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      env as any,
      bridgeData({ advertiseSpecVersion151: true }),
    );
    server = node;
    await node.construction.ready;
    expect(node.state.basicInformation.specificationVersion).toBe(17105152);
    expect(node.state.basicInformation.dataModelRevision).toBe(19);
  });

  it("the session parameters reach a real session manager before start", async () => {
    const node = await mount({ advertiseSpecVersion151: true });
    const sessionManager = node.env.get(SessionManager);
    applyLegacySpecSessionParameters(sessionManager, {
      advertiseSpecVersion151: true,
    });
    expect(sessionManager.sessionParameters.specificationVersion).toBe(
      17105152,
    );
    expect(sessionManager.sessionParameters.dataModelRevision).toBe(19);
  });
});
