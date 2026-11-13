import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { HomeAssistantActions } from "../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { createLegacyEndpointType } from "../endpoints/legacy/create-legacy-endpoint-type.js";

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bi-serial-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function serialOf(serialNumberSuffix: string): Promise<string> {
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      featureFlags: {},
      serialNumberSuffix,
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "riddix",
        productName: "MatterHub",
        productLabel: "Home Assistant Matter Hub",
        hardwareVersion: 1,
        softwareVersion: 1,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any),
  );
  const lock = {
    entity_id: "lock.front",
    state: {
      entity_id: "lock.front",
      state: "locked",
      attributes: { friendly_name: "Front" },
    },
  };
  const type = createLegacyEndpointType(lock as never, {
    entityId: "lock.front",
  })!;
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "bi-serial-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  try {
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(type, { id: "d" });
    await aggregator.add(endpoint);
    let serial = "";
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read basic info state
      serial = (agent as any).bridgedDeviceBasicInformation.state.serialNumber;
    });
    return serial;
  } finally {
    await server.close().catch(() => {});
  }
}

describe("basic information serial number", () => {
  it("cuts a long CJK suffix to 32 bytes", async () => {
    const serial = await serialOf("客厅空调伴侣插座电量统计");
    expect(Buffer.byteLength(serial)).toBeLessThanOrEqual(32);
    expect(serial).not.toContain("�");
    expect(serial.endsWith("客厅空调伴侣插座电量")).toBe(true);
  });

  it("appends a short suffix as before", async () => {
    const serial = await serialOf("-v2");
    expect(serial).toMatch(/^lock\.front-v2$/);
  });
});
