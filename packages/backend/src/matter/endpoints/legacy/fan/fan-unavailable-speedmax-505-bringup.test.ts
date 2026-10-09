import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
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
import { updateEntityState } from "../../update-entity-state.js";
import { FanDevice } from "./index.js";

// #505: HA drops percentage_step while a fan is unavailable. SpeedMax was
// recomputed from the 33.33 default and flipped 100 -> 3 -> 100 on every
// availability flap, although Matter defines it as a fixed attribute.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-fan-505-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
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
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fan(
  state: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const full = {
    entity_id: "fan.purifier",
    state,
    attributes: { friendly_name: "Purifier", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "fan.purifier", state: full as any };
}

const available = { supported_features: 1, percentage: 40, percentage_step: 1 };
// what HA keeps while unavailable: capability attributes only
const unavailable = { supported_features: 1 };

describe("fan SpeedMax across an unavailable phase (#505)", () => {
  it("keeps SpeedMax and FanModeSequence while HA drops percentage_step", async () => {
    const server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "fan-505-node",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(
      FanDevice({ entity: fan("on", available), mapping: undefined } as never),
      { id: "fan" },
    );
    await aggregator.add(endpoint);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const fc = () => endpoint.stateOf("fanControl" as any) as any;
    const settle = () => new Promise((r) => setTimeout(r, 50));
    const seen: { speedMax: number; fanModeSequence: number }[] = [];
    const record = () =>
      seen.push({
        speedMax: fc().speedMax,
        fanModeSequence: fc().fanModeSequence,
      });

    record();
    await updateEntityState(endpoint, fan("unavailable", unavailable).state);
    await settle();
    record();
    await updateEntityState(endpoint, fan("on", available).state);
    await settle();
    record();
    await server.close().catch(() => {});

    expect(seen[0].speedMax).toBe(100);
    expect(seen).toEqual([seen[0], seen[0], seen[0]]);
    expect(calls).toEqual([]);
  });
});
