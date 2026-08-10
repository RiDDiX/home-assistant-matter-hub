import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { FanDevice } from "./index.js";

// #443: controllers stream percentSetting while the user drags the slider, one
// Google Home drag was measured emitting nine writes in eight seconds. With
// fanSliderDebounceMs only the last write of the burst may reach HA.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

function setBridge(featureFlags?: Record<string, unknown>) {
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
  dir = mkdtempSync(join(tmpdir(), "hamh-fan443-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  setBridge();
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fanEntity(): HomeAssistantEntityInformation {
  const full = {
    entity_id: "fan.test",
    state: "on",
    attributes: {
      friendly_name: "Fan",
      supported_features: 1,
      percentage: 50,
      percentage_step: 1,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "fan.test", state: full as any };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setPercentageCalls(): number[] {
  return calls
    .filter((c) => c.action === "fan.set_percentage")
    .map((c) => (c.data as { percentage: number }).percentage);
}

// Mount a fan and replay a measured slider drag: nine percentSetting writes in
// separate transactions, like matter.js delivers them.
async function drag(
  mapping: EntityMappingConfig | undefined,
  settleMs: number,
): Promise<{ immediate: number[]; settled: number[] }> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fan443-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    FanDevice({ entity: fanEntity(), mapping } as never),
    { id: "fan" },
  );
  await aggregator.add(endpoint);

  calls.length = 0;
  for (const pct of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller write
      (agent as any).fanControl.targetPercentSettingChanged(pct, 0, {
        subject: {},
      });
    });
  }
  const immediate = setPercentageCalls();
  await wait(settleMs);
  const settled = setPercentageCalls();
  await server.close().catch(() => {});
  return { immediate, settled };
}

describe("fan slider debounce (#443)", () => {
  it("sends every write immediately when no debounce is configured", async () => {
    const { immediate } = await drag({ entityId: "fan.test" }, 0);
    expect(immediate).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it("collapses a nine-write drag into one dispatch, last value wins", async () => {
    const { immediate, settled } = await drag(
      { entityId: "fan.test", fanSliderDebounceMs: 100 },
      400,
    );
    expect(immediate).toEqual([]);
    expect(settled).toEqual([90]);
  });

  it("debounces via the per-bridge feature flag", async () => {
    setBridge({ fanSliderDebounceMs: 100 });
    const { immediate, settled } = await drag({ entityId: "fan.test" }, 400);
    expect(immediate).toEqual([]);
    expect(settled).toEqual([90]);
  });

  it("lets the per-entity override win over the bridge flag", async () => {
    // The bridge window is far beyond the settle wait, so a single dispatch
    // proves the entity's shorter window was the one used.
    setBridge({ fanSliderDebounceMs: 8000 });
    const { settled } = await drag(
      { entityId: "fan.test", fanSliderDebounceMs: 100 },
      400,
    );
    expect(settled).toEqual([90]);
  });

  it("treats a zero flag as disabled", async () => {
    setBridge({ fanSliderDebounceMs: 0 });
    const { immediate } = await drag({ entityId: "fan.test" }, 0);
    expect(immediate).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it("passes an isolated write straight through after the window", async () => {
    const server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "fan443-single-node",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(
      FanDevice({
        entity: fanEntity(),
        mapping: { entityId: "fan.test", fanSliderDebounceMs: 100 },
      } as never),
      { id: "fan" },
    );
    await aggregator.add(endpoint);

    calls.length = 0;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller write
      (agent as any).fanControl.targetPercentSettingChanged(40, 0, {
        subject: {},
      });
    });
    await wait(400);
    expect(setPercentageCalls()).toEqual([40]);
    await server.close().catch(() => {});
  });
});
