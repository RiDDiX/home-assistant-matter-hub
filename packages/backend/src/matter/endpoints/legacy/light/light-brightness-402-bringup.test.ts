import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HomeAssistantEntityInformation,
  LightDeviceColorMode,
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
import { LightDevice } from "./index.js";

// #402: Google Home "set light to 12%" sends moveToLevelWithOnOff level=30. The
// dimmable light used to map that to brightness 29 (downward bias) because the
// controller->HA path used a 253 range with a +1 offset while the config maps
// the fraction with *255. Matter level L (1..254) must map to brightness
// round(L / 254 * 255), so 30 stays 30 and the round-trip is stable.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-light402-"));
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

function lightEntity(
  entityId: string,
  brightness: number,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: entityId,
    state: "on",
    attributes: {
      friendly_name: "Light",
      supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
      color_mode: LightDeviceColorMode.BRIGHTNESS,
      brightness,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: state as any };
}

async function mount(entity: HomeAssistantEntityInformation) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `light402-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(LightDevice({ entity } as never), {
    id: "light",
  });
  await aggregator.add(endpoint);
  return { server, endpoint };
}

// Controller -> HA: drive moveToLevelWithOnOff and return the brightness HAMH
// forwards to light.turn_on.
async function levelToBrightness(level: number): Promise<number | undefined> {
  const entityId = `light.l402_${counter}`;
  const { server, endpoint } = await mount(lightEntity(entityId, 200));
  calls.length = 0;
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    const a = agent as any;
    await a.levelControl.moveToLevelWithOnOff({
      level,
      transitionTime: 0,
      optionsMask: {},
      optionsOverride: {},
    });
  });
  await server.close().catch(() => {});
  const call = calls.filter((c) => c.action === "light.turn_on").at(-1);
  return (call?.data as { brightness?: number } | undefined)?.brightness;
}

// HA -> controller: mount a light with the given brightness and read the Matter
// currentLevel the bridge exposes.
async function brightnessToLevel(
  brightness: number,
): Promise<number | undefined> {
  const entityId = `light.r402_${counter}`;
  const { server, endpoint } = await mount(lightEntity(entityId, brightness));
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const level = (endpoint.state as any).levelControl.currentLevel as number;
  await server.close().catch(() => {});
  return level;
}

describe("dimmable light brightness mapping (#402)", () => {
  // The reporter's table: each Matter level must arrive at HA unchanged.
  it.each([
    [25, 25],
    [28, 28],
    [30, 30],
    [33, 33],
    [1, 1],
    [254, 255],
  ])("maps level %i to brightness %i", async (level, brightness) => {
    expect(await levelToBrightness(level)).toBe(brightness);
  });

  it("round-trips brightness 30 through Matter without drift", async () => {
    const level = await brightnessToLevel(30);
    expect(level).toBe(30);
    // Controller echoes that level back; brightness must stay 30.
    expect(await levelToBrightness(level as number)).toBe(30);
  });
});
