import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FanWindPresets,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { FanDevice } from "./index.js";

// #387: wind was hardcoded to english presets, so localized names like 自然风
// never enabled the Wind feature. fanWindPresets maps them per entity.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-fanwind387-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fanEntity(
  state: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const full = {
    entity_id: "fan.test",
    state,
    attributes: { friendly_name: "Fan", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "fan.test", state: full as any };
}

async function windFeature(
  attributes: Record<string, unknown>,
  fanWindPresets?: FanWindPresets,
): Promise<boolean> {
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fanwind387-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    FanDevice({
      entity: fanEntity("off", attributes),
      mapping: fanWindPresets
        ? { entityId: "fan.test", fanWindPresets }
        : undefined,
    } as never),
    { id: "fan" },
  );
  await aggregator.add(endpoint);
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const fc = (endpoint.state as any).fanControl;
  const wind = fc.featureMap.wind as boolean;
  await server.close().catch(() => {});
  return wind;
}

describe("fan Wind feature honors localized preset mapping (#387)", () => {
  it("enables wind for a mapped localized natural preset", async () => {
    const wind = await windFeature(
      { supported_features: 8, preset_modes: ["直吹风", "自然风"] },
      { natural: ["自然风"] },
    );
    expect(wind).toBe(true);
  });

  it("still enables wind for english presets without a mapping", async () => {
    const wind = await windFeature({
      supported_features: 8,
      preset_modes: ["Natural", "Sleep", "Low"],
    });
    expect(wind).toBe(true);
  });

  it("stays off for localized presets with no mapping", async () => {
    const wind = await windFeature({
      supported_features: 8,
      preset_modes: ["直吹风", "自然风"],
    });
    expect(wind).toBe(false);
  });
});
