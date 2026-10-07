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
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LightDevice } from "./index.js";

// #510: Alexa sends On, then the color 30-200 ms later while HA still reports
// off. The color was staged for the next turn-on instead of reaching HA, so
// every "set to <color>" from off applied the previous request's color.

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
  dir = mkdtempSync(join(tmpdir(), "hamh-510-"));
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

// The reporter's template light: hs + color_temp, off reports hs_color null.
function colorLight(
  entityId: string,
  on: boolean,
  stamp = "2026-01-01T00:00:00",
): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state: on ? "on" : "off",
    attributes: {
      friendly_name: "Example",
      supported_color_modes: [
        LightDeviceColorMode.COLOR_TEMP,
        LightDeviceColorMode.HS,
      ],
      color_mode: on ? LightDeviceColorMode.HS : null,
      brightness: on ? 200 : null,
      hs_color: on ? [0, 100] : null,
      color_temp_kelvin: null,
      min_color_temp_kelvin: 2000,
      max_color_temp_kelvin: 6500,
    },
    context: { id: "ctx" },
    last_changed: stamp,
    last_updated: stamp,
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: s as any };
}

async function mount(entity: HomeAssistantEntityInformation) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `n510-${counter++}`,
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
const options = (executeIfOff: boolean) => ({
  optionsMask: { executeIfOff, coupleColorTempToLevel: false },
  optionsOverride: { executeIfOff, coupleColorTempToLevel: false },
});

// biome-ignore lint/suspicious/noExplicitAny: drive controller commands
type Agent = any;
const on = (e: Endpoint) => e.act((a: Agent) => a.onOff.on());
const off = (e: Endpoint) => e.act((a: Agent) => a.onOff.off());
const hs = (e: Endpoint, hue: number, executeIfOff = false) =>
  e.act((a: Agent) =>
    a.colorControl.moveToHueAndSaturation({
      hue,
      saturation: 254,
      transitionTime: 0,
      ...options(executeIfOff),
    }),
  );
const ct = (e: Endpoint, mireds: number, executeIfOff = false) =>
  e.act((a: Agent) =>
    a.colorControl.moveToColorTemperature({
      colorTemperatureMireds: mireds,
      transitionTime: 0,
      ...options(executeIfOff),
    }),
  );
const setHa = (e: Endpoint, entity: HomeAssistantEntityInformation) =>
  e.setStateOf(HomeAssistantEntityBehavior, { entity });

const turnOns = () => sent.filter((c) => c.service === "light.turn_on");
const hue = (c: { data: Record<string, unknown> }) =>
  (c.data.hs_color as number[] | undefined)?.[0];

// Let the 100 ms debounce flush everything.
const settle = () => wait(250);

describe("#510 color right after On on an off light", () => {
  it("sends the color to HA when it arrives after the On went out", async () => {
    const endpoint = await mount(colorLight("light.l510a", false));

    await on(endpoint);
    await wait(175);
    await hs(endpoint, 169);
    await settle();

    // blue, hue 169/254 of the wheel
    expect(turnOns().some((c) => (hue(c) ?? 0) > 230)).toBe(true);
  });

  it("merges a quick On and color into one turn_on with the color", async () => {
    const endpoint = await mount(colorLight("light.l510b", false));

    await on(endpoint);
    await wait(5);
    await hs(endpoint, 169);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), {
      timeout: 1000,
    });
    await settle();

    expect(turnOns()).toHaveLength(1);
    expect(hue(turnOns()[0])).toBeGreaterThan(230);
  });

  it("never carries the color into a later turn-on", async () => {
    const endpoint = await mount(colorLight("light.l510c", false));

    await on(endpoint);
    await wait(175);
    await hs(endpoint, 0);
    await settle();

    await setHa(
      endpoint,
      colorLight("light.l510c", false, "2026-01-01T00:01:00"),
    );
    await off(endpoint);
    await settle();
    sent.length = 0;

    await on(endpoint);
    await settle();
    expect(turnOns()).toEqual([{ service: "light.turn_on", data: {} }]);
  });

  it("sends a color temperature right after On as well", async () => {
    const endpoint = await mount(colorLight("light.l510d", false));

    await on(endpoint);
    await wait(175);
    await ct(endpoint, 370);
    await settle();

    expect(turnOns().some((c) => c.data.color_temp_kelvin != null)).toBe(true);
  });

  it("still stages a color the controller sets while the light is off", async () => {
    const endpoint = await mount(colorLight("light.l510e", false));

    await ct(endpoint, 370, true);
    await settle();
    expect(sent).toEqual([]);

    await on(endpoint);
    await settle();
    expect(turnOns()).toHaveLength(1);
    expect(turnOns()[0].data.color_temp_kelvin).toBeGreaterThan(2500);
  });

  it("does not switch the light back on for a color right after Off", async () => {
    const endpoint = await mount(colorLight("light.l510f", true));

    await off(endpoint);
    await wait(20);
    await ct(endpoint, 370, true);
    await settle();
    expect(turnOns()).toEqual([]);

    // the color waits for the next On
    await on(endpoint);
    await settle();
    expect(turnOns()).toHaveLength(1);
    expect(turnOns()[0].data.color_temp_kelvin).toBeGreaterThan(2500);
  });

  it("drops a staged color once HA turns the light on by itself", async () => {
    const endpoint = await mount(colorLight("light.l510g", false));

    await ct(endpoint, 370, true);
    await settle();

    // switched on outside Matter, then off again
    await setHa(
      endpoint,
      colorLight("light.l510g", true, "2026-01-01T00:01:00"),
    );
    await setHa(
      endpoint,
      colorLight("light.l510g", false, "2026-01-01T00:02:00"),
    );
    sent.length = 0;

    await on(endpoint);
    await settle();
    expect(turnOns()).toEqual([{ service: "light.turn_on", data: {} }]);
  });
});
