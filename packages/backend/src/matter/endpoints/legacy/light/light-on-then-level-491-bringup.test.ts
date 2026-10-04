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
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import type { HomeAssistantClient } from "../../../../services/home-assistant/home-assistant-client.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LightDevice } from "./index.js";

// #491: Alexa's "set to 20%" on an off light flashed to 100% first.

let dir: string;
let env: Environment;
let sent: { service: string; data: Record<string, unknown> }[];
let counter = 0;
let server: ServerNode | undefined;

function realActions() {
  const client = {
    haRunning: true,
    messageTimeoutMs: 1000,
    connection: {
      sendMessagePromise: async (message: {
        type: string;
        domain?: string;
        service?: string;
        service_data?: Record<string, unknown>;
      }) => {
        if (message.type === "call_service") {
          sent.push({
            service: `${message.domain}.${message.service}`,
            data: message.service_data ?? {},
          });
        }
        return {};
      },
    },
  } as unknown as HomeAssistantClient;
  const logger = {
    get: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  } as unknown as LoggerService;
  return new HomeAssistantActions(logger, client, {
    retryAttempts: 1,
    retryBaseDelayMs: 1,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-491-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  sent = [];
  env.set(HomeAssistantActions, realActions());
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
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function offLight(entityId: string): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state: "off",
    attributes: {
      friendly_name: "Büro Stehlampe",
      supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
      color_mode: null,
      brightness: null,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: s as any };
}

async function mount(entity: HomeAssistantEntityInformation) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `n491-${counter++}`,
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#491 Alexa set to 20% on an off light", () => {
  it("reaches Home Assistant as a single turn_on with the brightness", async () => {
    const endpoint = await mount(offLight("light.buro_stehlampe"));

    // act() adds delay on top of Alexa's 37ms, stay inside the 100ms window
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      await (agent as any).onOff.on();
    });
    await wait(5);
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      await (agent as any).levelControl.moveToLevel({
        level: 25,
        transitionTime: 0,
        optionsMask: { executeIfOff: false, coupleColorTempToLevel: false },
        optionsOverride: { executeIfOff: false, coupleColorTempToLevel: false },
      });
    });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), {
      timeout: 1000,
    });
    await wait(200);

    expect(sent).toHaveLength(1);
    expect(sent[0].service).toBe("light.turn_on");
    expect(sent[0].data.brightness).toBeGreaterThan(0);
    expect(sent[0].data.brightness).toBeLessThan(255);
  });

  it("still turns the light on when only On is sent", async () => {
    const endpoint = await mount(offLight("light.plain"));

    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      await (agent as any).onOff.on();
    });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), {
      timeout: 1000,
    });
    await wait(200);

    expect(sent).toEqual([{ service: "light.turn_on", data: {} }]);
  });
});
