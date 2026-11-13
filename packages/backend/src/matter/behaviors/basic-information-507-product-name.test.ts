import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { HomeAssistantActions } from "../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { createLegacyEndpointType } from "../endpoints/legacy/create-legacy-endpoint-type.js";

// #507: Apple Home shows productName as the model, so a Nuki lock reads "178"
// (HA model_id). productNameFromModel reports the HA model there instead.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bi-507-"));
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

async function productNameOf(
  featureFlags: Record<string, boolean>,
  mapping: EntityMappingConfig = { entityId: "lock.hilock" },
): Promise<string> {
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      featureFlags,
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
    entity_id: "lock.hilock",
    state: {
      entity_id: "lock.hilock",
      state: "locked",
      attributes: { friendly_name: "HiLoCk" },
    },
    deviceRegistry: {
      manufacturer: "Nuki",
      model: "Smart Lock Pro",
      model_id: "178",
    },
  };
  const type = createLegacyEndpointType(lock as never, mapping)!;
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "bi-507-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "d" });
  await aggregator.add(endpoint);
  let name = "";
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read basic info state
    name = (agent as any).bridgedDeviceBasicInformation.state.productName;
  });
  await server.close().catch(() => {});
  return name;
}

describe("basic information productNameFromModel (#507)", () => {
  it("keeps model_id as productName by default", async () => {
    expect(await productNameOf({})).toBe("178");
  });

  it("reports the HA model when the flag is on", async () => {
    expect(await productNameOf({ productNameFromModel: true })).toBe(
      "Smart Lock Pro",
    );
  });

  it("customProductName still wins over the flag", async () => {
    expect(
      await productNameOf(
        { productNameFromModel: true },
        { entityId: "lock.hilock", customProductName: "Front Door" },
      ),
    ).toBe("Front Door");
  });
});
