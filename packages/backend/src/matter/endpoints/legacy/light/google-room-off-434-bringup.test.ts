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
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import {
  DEFAULT_OFF_SUPPRESSION_WINDOW_MS,
  setOffSuppressionWindowMsForTests,
} from "../../../behaviors/level-control-server.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LightDevice } from "./index.js";

// #434: Google's "turn off the room" sends onOff.off, then ~10ms later a
// moveToLevelWithOnOff carrying the remembered level with an empty optionsMask.
// HAMH used to forward that as light.turn_on and the room lit back up.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-google434-"));
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

afterEach(async () => {
  // Optional call so a red-run against sources without the seam still shows
  // the real assertions instead of dying here.
  setOffSuppressionWindowMsForTests?.(DEFAULT_OFF_SUPPRESSION_WINDOW_MS);
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function dimmableLight(
  entityId: string,
  {
    brightness = 200,
    state = "on",
    lastChanged = "2026-01-01T00:00:00",
  }: { brightness?: number; state?: string; lastChanged?: string },
): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state,
    attributes: {
      friendly_name: "Light",
      supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
      color_mode: LightDeviceColorMode.BRIGHTNESS,
      brightness,
    },
    context: { id: "ctx" },
    last_changed: lastChanged,
    last_updated: lastChanged,
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: s as any };
}

async function mount(entity: HomeAssistantEntityInformation) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `google434-node-${counter++}`,
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
  return endpoint;
}

async function turnOff(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).onOff.off();
  });
}

async function turnOn(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).onOff.on();
  });
}

async function moveToLevelWithOnOff(endpoint: Endpoint, level: number) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).levelControl.moveToLevelWithOnOff({
      level,
      transitionTime: null,
      optionsMask: {},
      optionsOverride: {},
    });
  });
}

async function moveToLevel(endpoint: Endpoint, level: number) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).levelControl.moveToLevel({
      level,
      transitionTime: null,
      optionsMask: {},
      optionsOverride: {},
    });
  });
}

function turnOns() {
  return calls.filter((c) => c.action === "light.turn_on");
}

function currentLevel(endpoint: Endpoint) {
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  return (endpoint.state as any).levelControl.currentLevel as number;
}

describe("Google room-off then store level (#434)", () => {
  it("does not relight when the level arrives right after a Matter off", async () => {
    const endpoint = await mount(
      dimmableLight(`light.g434_${counter}`, { brightness: 200 }),
    );
    calls.length = 0;

    await turnOff(endpoint);
    await moveToLevelWithOnOff(endpoint, 15);

    expect(calls.map((c) => c.action)).toEqual(["homeassistant.turn_off"]);
    expect(turnOns()).toHaveLength(0);
    // Level is still remembered on the Matter attribute for the controller UI.
    expect(currentLevel(endpoint)).toBe(15);

    // A stale HA update (old last_changed, different content so the change
    // event actually fires) must not overwrite the remembered level: the
    // optimistic shield holds it.
    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: dimmableLight(`light.g434_${counter - 1}`, { brightness: 180 }),
    });
    expect(currentLevel(endpoint)).toBe(15);
  });

  it("still dims when no Matter off preceded the level command", async () => {
    const endpoint = await mount(
      dimmableLight(`light.g434_${counter}`, { brightness: 200 }),
    );
    calls.length = 0;

    await moveToLevelWithOnOff(endpoint, 15);

    expect(turnOns()).toHaveLength(1);
    expect(turnOns()[0]?.data).toMatchObject({ brightness: 15 });
  });

  it("still dims after on() followed by moveToLevel (Apple/Alexa)", async () => {
    const endpoint = await mount(
      dimmableLight(`light.g434_${counter}`, { brightness: 200, state: "off" }),
    );
    calls.length = 0;

    await turnOff(endpoint);
    await turnOn(endpoint);
    // Only the level command is under test, the on() already called HA.
    calls.length = 0;
    await moveToLevel(endpoint, 128);

    expect(turnOns()).toHaveLength(1);
    // round(128 / 254 * 255) = 129, the #402 mapping.
    expect(turnOns()[0]?.data).toMatchObject({ brightness: 129 });
  });

  it("still dims once the off window has expired", async () => {
    setOffSuppressionWindowMsForTests(1);
    const endpoint = await mount(
      dimmableLight(`light.g434_${counter}`, { brightness: 200 }),
    );
    calls.length = 0;

    await turnOff(endpoint);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await moveToLevelWithOnOff(endpoint, 15);

    expect(turnOns()).toHaveLength(1);
    expect(turnOns()[0]?.data).toMatchObject({ brightness: 15 });
  });

  it("still dims a light that HA turned off, not Matter", async () => {
    const endpoint = await mount(
      dimmableLight(`light.g434_${counter}`, { brightness: 200, state: "off" }),
    );
    calls.length = 0;

    // No Matter off command, so no timestamp: the guard must stay inert even
    // though the light reads off.
    await moveToLevelWithOnOff(endpoint, 15);

    expect(turnOns()).toHaveLength(1);
    expect(turnOns()[0]?.data).toMatchObject({ brightness: 15 });
  });

  it("lets the level through when a wall switch relit the lamp inside the window", async () => {
    const entityId = `light.g434_${counter}`;
    const endpoint = await mount(dimmableLight(entityId, { brightness: 200 }));
    await turnOff(endpoint);
    // HA reports a FRESH on: the wall switch beat the level command.
    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: dimmableLight(entityId, {
        state: "on",
        lastChanged: new Date().toISOString(),
      }),
    });
    calls.length = 0;

    await moveToLevelWithOnOff(endpoint, 15);

    expect(turnOns()).toHaveLength(1);
  });
});
