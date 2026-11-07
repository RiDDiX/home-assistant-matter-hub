import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, type EndpointType, VendorId } from "@matter/main";
import { FanControl } from "@matter/main/clusters";
import { FanDevice as MatterFanDevice } from "@matter/main/devices";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ClimateFanControlServer } from "../climate/behaviors/climate-fan-control-server.js";
import { FanDevice } from "./index.js";

// Step always sent turnOn(percent), so preset-only fans got a rejected
// fan.set_percentage and climate fans the literal fan_mode "on".

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-fan-step-"));
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

function entity(
  entityId: string,
  state: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityBehavior.State {
  const full = {
    entity_id: entityId,
    state,
    attributes: { friendly_name: "Fan", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  return { entity: { entity_id: entityId, state: full } } as never;
}

async function stepUp(type: EndpointType): Promise<HomeAssistantAction[]> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fan-step-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "fan" });
  await aggregator.add(endpoint);

  calls.length = 0;
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).fanControl.step({
      direction: FanControl.StepDirection.Increase,
      wrap: false,
      lowestOff: true,
    });
  });
  await server.close().catch(() => {});
  return calls;
}

describe("fan Step routes through the preset branch", () => {
  it("sends the next preset on a preset-only fan", async () => {
    const sent = await stepUp(
      FanDevice(
        entity("fan.test", "on", {
          supported_features: 8, // PRESET_MODE
          preset_modes: ["Low", "Medium", "High"],
          preset_mode: "Low",
        }),
      ),
    );
    expect(sent).toEqual([
      { action: "fan.set_preset_mode", data: { preset_mode: "Medium" } },
    ]);
  });

  it("sends a declared fan mode on a climate fan", async () => {
    const sent = await stepUp(
      MatterFanDevice.with(
        HomeAssistantEntityBehavior,
        ClimateFanControlServer(undefined, false),
      ).set({
        homeAssistantEntity: entity("climate.test", "cool", {
          fan_modes: ["low", "medium", "high"],
          fan_mode: "low",
        }),
      }),
    );
    expect(sent).toEqual([
      { action: "climate.set_fan_mode", data: { fan_mode: "medium" } },
    ]);
  });
});
