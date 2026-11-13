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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoggerService } from "../../../../core/app/logger.js";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import type { HomeAssistantClient } from "../../../../services/home-assistant/home-assistant-client.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { CoverDevice } from "../cover/index.js";
import { LightDevice } from "./index.js";

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-level-onoff-"));
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
      featureFlags: {},
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
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function hsLight(entityId: string): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state: "off",
    attributes: {
      friendly_name: "Light",
      supported_color_modes: [LightDeviceColorMode.HS],
      color_mode: LightDeviceColorMode.HS,
      brightness: 26,
      hs_color: [30, 50],
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: s as any };
}

async function mount(
  entity: HomeAssistantEntityInformation,
  device: typeof LightDevice = LightDevice,
  mapping?: unknown,
) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `level-onoff-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(device({ entity, mapping } as never), {
    id: "light",
  });
  await aggregator.add(endpoint);
  return endpoint;
}

// biome-ignore lint/suspicious/noExplicitAny: drive the controller command
type Agent = any;

async function act(endpoint: Endpoint, fn: (agent: Agent) => unknown) {
  await endpoint.act(async (agent) => {
    await fn(agent);
  });
}

function onOf(endpoint: Endpoint): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  return (endpoint.state as any).onOff.onOff;
}

const noOptions = { optionsMask: {}, optionsOverride: {} };

describe("level WithOnOff turns Matter OnOff on", () => {
  it("moveToLevelWithOnOff then colour", async () => {
    const endpoint = await mount(hsLight(`light.lw_${counter}`));
    calls.length = 0;

    await act(endpoint, (agent) =>
      agent.levelControl.moveToLevelWithOnOff({
        level: 200,
        transitionTime: null,
        ...noOptions,
      }),
    );
    expect(onOf(endpoint)).toBe(true);

    await act(endpoint, (agent) =>
      agent.colorControl.moveToHueAndSaturation({
        hue: 100,
        saturation: 200,
        transitionTime: 0,
        ...noOptions,
      }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      action: "light.turn_on",
      data: { brightness: 201 },
    });
    expect(calls[1]?.action).toBe("light.turn_on");
    expect(calls[1]?.data).toHaveProperty("hs_color");
  });

  it("stepWithOnOff", async () => {
    const endpoint = await mount(hsLight(`light.lw_${counter}`));
    calls.length = 0;

    await act(endpoint, (agent) =>
      agent.levelControl.stepWithOnOff({
        stepMode: 0,
        stepSize: 50,
        transitionTime: null,
        ...noOptions,
      }),
    );

    expect(onOf(endpoint)).toBe(true);
    expect(calls.map((c) => c.action)).toEqual(["light.turn_on"]);
    expect(calls[0]?.data).toHaveProperty("brightness");
  });

  it("moveToLevel without OnOff leaves it off", async () => {
    const endpoint = await mount(hsLight(`light.lw_${counter}`));

    await act(endpoint, (agent) =>
      agent.levelControl.moveToLevel({
        level: 200,
        transitionTime: null,
        ...noOptions,
      }),
    );

    expect(onOf(endpoint)).toBe(false);
  });

  it("Google room off window keeps it off", async () => {
    const endpoint = await mount(hsLight(`light.lw_${counter}`));
    await act(endpoint, (agent) => agent.onOff.on());
    calls.length = 0;

    await act(endpoint, (agent) => agent.onOff.off());
    await act(endpoint, (agent) =>
      agent.levelControl.moveToLevelWithOnOff({
        level: 15,
        transitionTime: null,
        ...noOptions,
      }),
    );

    expect(onOf(endpoint)).toBe(false);
    expect(calls.map((c) => c.action)).toEqual(["homeassistant.turn_off"]);
  });
});

describe("level WithOnOff on a cover shown as a light", () => {
  it("leaves OnOff off when the level closes the cover", async () => {
    const entityId = `cover.lw_${counter}`;
    const s = {
      entity_id: entityId,
      state: "closed",
      attributes: { friendly_name: "Cover", supported_features: 3 },
      context: { id: "ctx" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
    };
    const endpoint = await mount(
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { entity_id: entityId, state: s as any },
      CoverDevice as typeof LightDevice,
      { entityId, coverExposeAsDimmableLight: true },
    );
    calls.length = 0;

    await act(endpoint, (agent) =>
      agent.levelControl.moveToLevelWithOnOff({
        level: 50,
        transitionTime: null,
        ...noOptions,
      }),
    );

    expect(onOf(endpoint)).toBe(false);
    expect(calls.map((c) => c.action)).toEqual(["cover.close_cover"]);
  });
});

describe("level WithOnOff on a failed HA call", () => {
  it("returns OnOff to the HA state", async () => {
    const sent: string[] = [];
    const client = {
      haRunning: true,
      messageTimeoutMs: 1000,
      connection: {
        sendMessagePromise: async (message: {
          type: string;
          domain?: string;
          service?: string;
        }) => {
          if (message.type !== "call_service") return {};
          sent.push(`${message.domain}.${message.service}`);
          throw { code: "home_assistant_error", message: "failed" };
        },
      },
    } as unknown as HomeAssistantClient;
    const logger = {
      get: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    } as unknown as LoggerService;
    env.set(
      HomeAssistantActions,
      new HomeAssistantActions(logger, client, {
        retryAttempts: 1,
        retryBaseDelayMs: 1,
      }),
    );
    const endpoint = await mount(hsLight(`light.lw_${counter}`));

    await act(endpoint, (agent) =>
      agent.levelControl.moveToLevelWithOnOff({
        level: 200,
        transitionTime: null,
        ...noOptions,
      }),
    );
    expect(onOf(endpoint)).toBe(true);

    await vi.waitFor(
      () => {
        expect(sent).toContain("light.turn_on");
        expect(onOf(endpoint)).toBe(false);
      },
      { timeout: 1000, interval: 20 },
    );
  });
});
