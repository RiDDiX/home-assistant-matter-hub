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
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { LightDevice } from "../endpoints/legacy/light/index.js";

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let calls: HomeAssistantAction[];
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-level-"));
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
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

// Brightness 128 is Matter level round(128 / 255 * 254) = 127.
async function mountLight(haState = "on", withOnOff = false) {
  const entityId = `light.level_${counter}`;
  const entity: HomeAssistantEntityInformation = {
    entity_id: entityId,
    state: {
      entity_id: entityId,
      state: haState,
      attributes: {
        supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
        color_mode: LightDeviceColorMode.BRIGHTNESS,
        brightness: 128,
      },
      context: { id: "c" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
  };
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `level-node-${counter++}`,
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
  calls.length = 0;
  return (level: number) =>
    endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      await (agent as any).levelControl[
        withOnOff ? "moveToLevelWithOnOff" : "moveToLevel"
      ]({
        level,
        transitionTime: 0,
        optionsMask: {},
        optionsOverride: {},
      });
    });
}

describe("moveToLevel", () => {
  it("sends nothing to HA for the level HA already shows", async () => {
    const moveToLevel = await mountLight();
    await moveToLevel(127);
    expect(calls).toEqual([]);
  });

  it("still sends it while a newer write is in flight", async () => {
    const moveToLevel = await mountLight();
    await moveToLevel(200);
    await moveToLevel(127);
    expect(
      calls.map((c) => (c.data as { brightness?: number }).brightness),
    ).toEqual([201, 128]);
  });

  it("turns on an off light that still carries the requested brightness", async () => {
    const moveToLevelWithOnOff = await mountLight("off", true);
    await moveToLevelWithOnOff(127);
    expect(calls).toEqual([
      expect.objectContaining({
        action: "light.turn_on",
        data: expect.objectContaining({ brightness: 128 }),
      }),
    ]);
  });

  it("sends nothing with OnOff for an on light already at that level", async () => {
    const moveToLevelWithOnOff = await mountLight("on", true);
    await moveToLevelWithOnOff(127);
    expect(calls).toEqual([]);
  });
});
