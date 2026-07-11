import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { SwitchDevice } from "../endpoints/legacy/switch/index.js";

// #385: uniqueId is md5(entity_id) and never changes, so a controller with a
// stale cloud record keyed on it (Alexa) re-attaches that record to every
// fresh bridge. uniqueIdSuffix gives users a way to mint a new identity.

let dir: string;
let env: Environment;

let bridgeSeq = 0;

function setupEnv(uniqueIdSuffix?: string) {
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      // Fresh bridge id per mount, the uniqueId freeze is per bridge+entity.
      id: `b${bridgeSeq++}`,
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      uniqueIdSuffix,
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "t",
        productName: "t",
        productLabel: "t",
        hardwareVersion: 1,
        softwareVersion: 1,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-uid-385-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function switchEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "switch.test",
    state: "off",
    attributes: { friendly_name: "Switch" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "switch.test", state: state as any };
}

async function mountedIdentity(
  uniqueIdSuffix?: string,
): Promise<{ uniqueId?: string; serialNumber?: string }> {
  setupEnv(uniqueIdSuffix);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `uid-385-node-${bridgeSeq}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    SwitchDevice({ entity: switchEntity() } as never),
    { id: "sw" },
  );
  await aggregator.add(endpoint);

  const out: { uniqueId?: string; serialNumber?: string } = {};
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read runtime state
    const s = (agent as any).bridgedDeviceBasicInformation.state;
    out.uniqueId = s.uniqueId;
    out.serialNumber = s.serialNumber;
  });
  await server.close().catch(() => {});
  return out;
}

const md5 = (v: string) =>
  crypto.createHash("md5").update(v).digest("hex").substring(0, 32);

describe("uniqueIdSuffix (#385)", () => {
  it("keeps uniqueId stable when no suffix is set (#53 dedup)", async () => {
    const { uniqueId } = await mountedIdentity(undefined);
    expect(uniqueId).toBe(md5("switch.test"));
  });

  it("mints a new deterministic uniqueId when the suffix is set", async () => {
    const { uniqueId } = await mountedIdentity("v2");
    expect(uniqueId).toBe(md5("switch.testv2"));
    expect(uniqueId).not.toBe(md5("switch.test"));
  });

  it("leaves the serialNumber alone", async () => {
    const { serialNumber } = await mountedIdentity("v2");
    expect(serialNumber).toBe("switch.test");
  });

  it("freezes the uniqueId for the process even if the suffix changes", async () => {
    // UniqueID is fixed quality, a live suffix edit must not flip it. The
    // same bridge id is reused here on purpose.
    const first = await mountedIdentity("v3");
    bridgeSeq--; // reuse the same bridge id for the second mount
    const second = await mountedIdentity("v4");
    expect(first.uniqueId).toBe(md5("switch.testv3"));
    expect(second.uniqueId).toBe(first.uniqueId);
  });
});
