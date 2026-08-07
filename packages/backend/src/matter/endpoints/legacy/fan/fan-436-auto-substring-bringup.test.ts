import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { FanControl } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { FanDevice } from "./index.js";

// #436 review: the Auto feature gate used /auto/i, so a preset like
// "Auto Comfort" compiled the AUT feature while update() looked for an exact
// "auto" preset and computed a non-auto sequence. matter.js rejects that pair
// with a "[!AUT].a" conformance error on every update, so the cluster kept the
// stale seed instead of the entity's real sequence.

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-fan436-"));
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

async function bringUp(attributes: Record<string, unknown>) {
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fan436-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    FanDevice({ entity: fanEntity("off", attributes) } as never),
    { id: "fan" },
  );
  await aggregator.add(endpoint);
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const fc = (endpoint.state as any).fanControl;
  const snapshot = {
    auto: fc.featureMap.auto as boolean,
    sequence: fc.fanModeSequence as FanControl.FanModeSequence,
    speedMax: fc.speedMax as number,
  };
  await server.close().catch(() => {});
  return snapshot;
}

describe("fan Auto feature requires an exact auto preset (#436)", () => {
  it("treats 'Auto Comfort' as a plain preset, not an Auto mode", async () => {
    const fc = await bringUp({
      supported_features: 8, // PRESET_MODE
      preset_modes: ["Auto Comfort", "low", "high"],
    });
    expect(fc.auto).toBe(false);
    // All three presets stay commandable speeds, and with Auto absent the
    // sequence must be one of the non-auto values or matter.js rejects it.
    expect(fc.sequence).toBe(FanControl.FanModeSequence.OffLowMedHigh);
    expect(fc.speedMax).toBe(3);
  });

  it("advertises Auto for an exact auto preset regardless of case", async () => {
    const fc = await bringUp({
      supported_features: 8,
      preset_modes: ["AUTO", "low", "high"],
    });
    expect(fc.auto).toBe(true);
    expect(fc.sequence).toBe(FanControl.FanModeSequence.OffLowHighAuto);
    expect(fc.speedMax).toBe(2);
  });
});
