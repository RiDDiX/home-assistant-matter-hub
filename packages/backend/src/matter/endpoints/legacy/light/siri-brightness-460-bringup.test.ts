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
import { FabricManager } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { commandFromAlexa } from "../../../behaviors/level-control-server.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LightDevice } from "./index.js";

// #460: alexaPreserveBrightnessOnTurnOn dropped every moveToLevel(254) that
// followed a turn-on, whoever sent it. On a bridge shared with Apple Home that
// swallowed Siri's "set the lights to 100%". The suppression now only applies
// to commands coming in over the Alexa fabric.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-siri460-"));
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
      featureFlags: { alexaPreserveBrightnessOnTurnOn: true },
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

function dimmableLight(entityId: string): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state: "on",
    attributes: {
      friendly_name: "Light",
      supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
      color_mode: LightDeviceColorMode.BRIGHTNESS,
      brightness: 26,
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
    id: `siri460-node-${counter++}`,
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

// Siri's "set to 100%": onOff.on() and moveToLevelWithOnOff(254) right after.
async function siriFullBrightness(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).onOff.on();
  });
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).levelControl.moveToLevelWithOnOff({
      level: 254,
      transitionTime: null,
      optionsMask: {},
      optionsOverride: {},
    });
  });
}

function fabricEnv(rootVendorId: number): Environment {
  const stub = new Environment("fabric-stub", Environment.default);
  stub.set(FabricManager, {
    maybeFor: () => ({ rootVendorId }),
    // biome-ignore lint/suspicious/noExplicitAny: fabric manager stub
  } as any);
  return stub;
}

describe("#460 Siri set to 100% with the Alexa flag enabled", () => {
  it("still sends the brightness when the command is not from Alexa", async () => {
    const endpoint = await mount(dimmableLight(`light.siri460_${counter}`));
    calls.length = 0;

    await siriFullBrightness(endpoint);

    const brightness = calls
      .filter((c) => c.action === "light.turn_on")
      .map((c) => (c.data as { brightness?: number } | undefined)?.brightness)
      .filter((value) => value != null);
    expect(brightness).toEqual([255]);
  });

  it("classifies the sending fabric", () => {
    expect(commandFromAlexa({ fabric: 1 as never }, fabricEnv(4631))).toBe(
      true,
    );
    expect(commandFromAlexa({ fabric: 1 as never }, fabricEnv(4937))).toBe(
      false,
    );
    expect(commandFromAlexa({}, fabricEnv(4631))).toBe(false);
  });
});
