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

// #385: a fan's model ("Mi Smart Standing Fan") leaks into productLabel, which a
// user could not override. customProductName now also neutralizes productLabel.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bi-385-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
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
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function productLabelOf(mapping: EntityMappingConfig): Promise<string> {
  const fan = {
    entity_id: "fan.jodienda",
    state: {
      entity_id: "fan.jodienda",
      state: "on",
      attributes: { friendly_name: "jodienda" },
    },
    deviceRegistry: { model: "Mi Smart Standing Fan 2" },
  };
  const type = createLegacyEndpointType(fan as never, mapping)!;
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "bi-385-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "d" });
  await aggregator.add(endpoint);
  let label = "";
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read basic info state
    label = (agent as any).bridgedDeviceBasicInformation.state.productLabel;
  });
  await server.close().catch(() => {});
  return label;
}

describe("basic information productLabel override (#385)", () => {
  it("customProductName also neutralizes productLabel", async () => {
    const label = await productLabelOf({
      entityId: "fan.jodienda",
      matterDeviceType: "on_off_plugin_unit",
      customProductName: "Plug",
    });
    expect(label).toBe("Plug");
  });

  it("keeps the device model when no custom name is set", async () => {
    const label = await productLabelOf({
      entityId: "fan.jodienda",
      matterDeviceType: "on_off_plugin_unit",
    });
    expect(label).toBe("Mi Smart Standing Fan 2");
  });
});
