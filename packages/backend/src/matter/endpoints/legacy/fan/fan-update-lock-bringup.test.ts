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

// A Home Assistant state change must reach the FanControl cluster. The
// fan's update reactor locks both fanControl and fanSpeedMemory; passing the
// behavior instances as lock resources made matter.js's post-lock check read
// lockedBy off the behavior instead of its datasource, so every HA update
// threw "Lock of ...fanControl should be held by reactor ... but is not" and
// the cluster kept its old state. Controllers then saw a stale fan.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-fan-lock-"));
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

function fanEntity(): HomeAssistantEntityInformation {
  const full = {
    entity_id: "fan.test",
    state: "off",
    attributes: {
      friendly_name: "Fan",
      supported_features: 1,
      percentage: 0,
      percentage_step: 1,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "fan.test", state: full as any };
}

describe("HA state updates reach the fan cluster", () => {
  it("applies an HA turn-on and percentage to FanControl", async () => {
    const server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "fan-lock-node",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(
      FanDevice({ entity: fanEntity(), mapping: undefined } as never),
      { id: "fan" },
    );
    await aggregator.add(endpoint);

    const on = fanEntity().state;
    on.state = "on";
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (on.attributes as any).percentage = 66;
    await updateEntityState(endpoint, on);
    // let the post-commit reactor finish
    await new Promise((r) => setTimeout(r, 50));

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const fc = endpoint.stateOf("fanControl" as any) as any;
    const memory = endpoint.stateOf(
      // biome-ignore lint/suspicious/noExplicitAny: read memory state
      "fanSpeedMemory" as any,
      // biome-ignore lint/suspicious/noExplicitAny: read memory state
    ) as any;
    await server.close().catch(() => {});

    expect(fc.percentSetting).toBe(66);
    expect(fc.fanMode).not.toBe(0); // not Off
    expect(memory.lastPercent).toBe(66);
    // an HA update must not be sent back to HA
    expect(calls).toEqual([]);
  });
});
