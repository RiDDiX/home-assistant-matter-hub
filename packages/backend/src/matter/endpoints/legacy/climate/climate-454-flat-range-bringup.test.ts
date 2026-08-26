import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ClimateDevice } from "./index.js";

// #454 (filed against the archived upstream image): a heat_cool climate with
// ONE flat min_temp/max_temp crashed upstream on the setpoint deadband
// assertion. This fork runs deadband 0 (#435), so equal heat/cool limits are
// legal. These tests pin that the exact reporter shape mounts and updates
// cleanly, and that a widening update lands whole. The widen case cannot go
// red on matter.js 0.17.9 (its reconciler would repair the transient), it
// guards the next matter.js bump together with the abs-before-user write
// order in the thermostat update.

let dir: string;
let env: Environment;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-454-"));
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
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function acEntity(
  state: string,
  minTemp: number,
  maxTemp: number,
): HomeAssistantEntityInformation {
  const s = {
    entity_id: "climate.living_room_ac",
    state,
    attributes: {
      hvac_modes: ["off", "cool", "heat", "heat_cool", "fan_only", "dry"],
      min_temp: minTemp,
      max_temp: maxTemp,
      target_temp_step: 1,
      current_temperature: 25.5,
      temperature: 26,
      supported_features: 425,
      friendly_name: "Living Room AC",
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: new Date().toISOString(),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "climate.living_room_ac", state: s as any };
}

async function mount(entity: HomeAssistantEntityInformation) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `node454-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(ClimateDevice({ entity } as never), {
    id: "ac",
  });
  await aggregator.add(endpoint);
  return { server, endpoint };
}

// biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
const thermostat = (endpoint: Endpoint) => (endpoint.state as any).thermostat;

describe("flat heat_cool range (#454)", () => {
  it("mounts the reporter shape with deadband 0 and equal limits", async () => {
    const { server, endpoint } = await mount(acEntity("cool", 16, 31));
    const t = thermostat(endpoint);
    expect(t.minSetpointDeadBand).toBe(0);
    expect(t.minHeatSetpointLimit).toBe(1600);
    expect(t.minCoolSetpointLimit).toBe(1600);
    expect(t.maxHeatSetpointLimit).toBe(3100);
    expect(t.maxCoolSetpointLimit).toBe(3100);

    // the state change that killed the upstream image, must stay a no-op here
    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: acEntity("heat_cool", 16, 31),
    });
    expect(thermostat(endpoint).minHeatSetpointLimit).toBe(1600);
    await server.close();
  });

  it("a widening range update lands whole", async () => {
    const { server, endpoint } = await mount(acEntity("cool", 24, 26));
    expect(thermostat(endpoint).minCoolSetpointLimit).toBe(2400);

    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: acEntity("cool", 16, 31),
    });
    const t = thermostat(endpoint);
    expect(t.minCoolSetpointLimit).toBe(1600);
    expect(t.maxCoolSetpointLimit).toBe(3100);
    expect(t.absMinCoolSetpointLimit).toBe(1600);
    expect(t.absMaxCoolSetpointLimit).toBe(3100);
    await server.close();
  });
});
