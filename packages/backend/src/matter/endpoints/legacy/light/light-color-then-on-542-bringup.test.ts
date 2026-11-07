import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HomeAssistantEntityInformation,
  LightDeviceColorMode,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { OnOffServer } from "@matter/main/behaviors";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoggerService } from "../../../../core/app/logger.js";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import type { HomeAssistantClient } from "../../../../services/home-assistant/home-assistant-client.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LightDevice } from "./index.js";

// #542: Google sends the color with a transition, then On. HA got the color
// and a bare turn_on right after it, and the bare one cut the transition short
// on a Shelly RGBW, so the light kept its old color.

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
  dir = mkdtempSync(join(tmpdir(), "hamh-542-"));
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

// The reporter's Shelly Plus RGBW PM: rgbw only, blue while on.
function rgbwLight(
  entityId: string,
  on: boolean,
  extra: Record<string, unknown> = {},
): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state: on ? "on" : "off",
    attributes: {
      friendly_name: "Example",
      supported_color_modes: [LightDeviceColorMode.RGBW],
      color_mode: on ? LightDeviceColorMode.RGBW : null,
      brightness: on ? 200 : null,
      hs_color: on ? [240, 100] : null,
      rgbw_color: on ? [0, 0, 255, 0] : null,
      ...extra,
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
    id: `n542-${counter++}`,
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
// what Google sends with a voice color command
const options = {
  optionsMask: { executeIfOff: true },
  optionsOverride: { executeIfOff: true },
};

// biome-ignore lint/suspicious/noExplicitAny: drive controller commands
type Agent = any;
const on = (e: Endpoint) => e.act((a: Agent) => a.onOff.on());
const red = (e: Endpoint) =>
  e.act((a: Agent) =>
    a.colorControl.moveToHueAndSaturation({
      hue: 0,
      saturation: 254,
      transitionTime: 2,
      ...options,
    }),
  );
const level = (e: Endpoint, value: number) =>
  e.act((a: Agent) =>
    a.levelControl.moveToLevel({ level: value, transitionTime: 2, ...options }),
  );

const turnOns = () => sent.filter((c) => c.service === "light.turn_on");

// Let the 100 ms debounce flush everything.
const settle = () => wait(250);

describe("#542 color then On from Google", () => {
  it("sends only the color when the light is already on", async () => {
    const endpoint = await mount(rgbwLight("light.l542a", true));

    await red(endpoint);
    await wait(3);
    await on(endpoint);
    await settle();

    expect(turnOns()).toEqual([
      {
        service: "light.turn_on",
        data: { hs_color: [0, 100], transition: 0.2 },
      },
    ]);
  });

  it("drops the On after a level change on a light that is on", async () => {
    const endpoint = await mount(rgbwLight("light.l542b", true));

    await level(endpoint, 100);
    await wait(3);
    await on(endpoint);
    await settle();

    expect(turnOns()).toHaveLength(1);
    expect(turnOns()[0].data).toMatchObject({ transition: 0.2 });
  });

  it("turns an off light on with the color in one call", async () => {
    const endpoint = await mount(rgbwLight("light.l542c", false));

    await red(endpoint);
    await wait(3);
    await on(endpoint);
    await settle();

    expect(turnOns()).toEqual([
      {
        service: "light.turn_on",
        data: { hs_color: [0, 100], transition: 0.2 },
      },
    ]);
  });

  // #453: some lights only switch on through the bare On
  it("keeps the On while HA still reports the light off", async () => {
    const endpoint = await mount(rgbwLight("light.l542d", false));

    await level(endpoint, 100);
    await wait(3);
    await on(endpoint);
    await settle();

    expect(turnOns()).toHaveLength(2);
    expect(turnOns()).toContainEqual({ service: "light.turn_on", data: {} });
  });

  it("keeps the second On of On, level, On while HA still reports off", async () => {
    const endpoint = await mount(rgbwLight("light.l542g", false));

    // the level drops the first On (#491), Matter already shows on
    await on(endpoint);
    await wait(3);
    await level(endpoint, 100);
    await wait(3);
    await on(endpoint);
    await settle();

    // a slow commit can let the first On out as well, so no exact count
    expect(turnOns().some((c) => c.data.brightness != null)).toBe(true);
    expect(turnOns()).toContainEqual({ service: "light.turn_on", data: {} });
  });

  it("keeps the On while Matter still shows the light off", async () => {
    const endpoint = await mount(rgbwLight("light.l542h", true));
    // HA has not caught up with an earlier off yet
    await endpoint.setStateOf(OnOffServer, { onOff: false });

    await level(endpoint, 100);
    await wait(3);
    await on(endpoint);
    await settle();

    expect(turnOns()).toHaveLength(2);
    expect(turnOns()).toContainEqual({ service: "light.turn_on", data: {} });
  });

  it("keeps the On for a light whose state HA only assumes", async () => {
    const endpoint = await mount(
      rgbwLight("light.l542e", true, { assumed_state: true }),
    );

    await red(endpoint);
    await wait(3);
    await on(endpoint);
    await settle();

    expect(turnOns()).toHaveLength(2);
    expect(turnOns()).toContainEqual({ service: "light.turn_on", data: {} });
  });

  it("still sends a plain On to a light that is on", async () => {
    const endpoint = await mount(rgbwLight("light.l542f", true));

    await on(endpoint);
    await settle();

    expect(turnOns()).toEqual([{ service: "light.turn_on", data: {} }]);
  });
});
