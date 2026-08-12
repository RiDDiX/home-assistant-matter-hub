import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityInformation,
  MatterDeviceType,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginEndpointType } from "../../plugins/plugin-device-factory.js";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantRegistry } from "../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { createLegacyEndpointType } from "../endpoints/legacy/create-legacy-endpoint-type.js";

// #447: Identify was accepted and then dropped for every device type except
// vacuums. It now presses the identify button sitting on the same HA device.

const DEVICE = "dev-1";

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

// biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
function setRegistry(
  entities: Record<string, any>,
  states: Record<string, any> = {},
) {
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  env.set(HomeAssistantRegistry, { entities, states } as any);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-447-"));
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
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function lightEntity(entityId: string): HomeAssistantEntityInformation {
  const state = {
    entity_id: entityId,
    state: "off",
    attributes: { friendly_name: "Lamp" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  return {
    entity_id: entityId,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    state: state as any,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    registry: { entity_id: entityId, device_id: DEVICE } as any,
  };
}

async function newServer() {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `id447-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  return aggregator;
}

async function mountLight(entityId: string) {
  const aggregator = await newServer();
  const info = lightEntity(entityId);
  const type = createLegacyEndpointType(info, {
    entityId,
    matterDeviceType: "on_off_light" as MatterDeviceType,
  });
  if (!type) throw new Error("no endpoint type");
  const endpoint = new Endpoint(type, { id: "dev" });
  await aggregator.add(endpoint);
  return endpoint;
}

async function identify(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive controller command
    await (agent as any).identify.identify({ identifyTime: 5 });
  });
}

describe("identify maps to the HA identify button (#447)", () => {
  it("presses a sibling button flagged device_class identify", async () => {
    setRegistry(
      {
        "light.lamp": { entity_id: "light.lamp", device_id: DEVICE },
        "button.press_me": { entity_id: "button.press_me", device_id: DEVICE },
      },
      {
        "button.press_me": { attributes: { device_class: "identify" } },
      },
    );
    const endpoint = await mountLight("light.lamp");
    calls.length = 0;

    await identify(endpoint);

    expect(calls).toEqual([
      { action: "button.press", target: "button.press_me" },
    ]);
  });

  it("falls back to a button named for identify", async () => {
    setRegistry({
      "light.lamp2": { entity_id: "light.lamp2", device_id: DEVICE },
      "button.lamp_locate": {
        entity_id: "button.lamp_locate",
        device_id: DEVICE,
      },
    });
    const endpoint = await mountLight("light.lamp2");
    calls.length = 0;

    await identify(endpoint);

    expect(calls).toEqual([
      { action: "button.press", target: "button.lamp_locate" },
    ]);
  });

  it("does nothing when the device has no identify entity", async () => {
    setRegistry({
      "light.lamp3": { entity_id: "light.lamp3", device_id: DEVICE },
      "button.reboot": { entity_id: "button.reboot", device_id: DEVICE },
    });
    const endpoint = await mountLight("light.lamp3");
    calls.length = 0;

    await expect(identify(endpoint)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("skips a disabled identify button", async () => {
    setRegistry(
      {
        "light.lamp4": { entity_id: "light.lamp4", device_id: DEVICE },
        "button.old_locate": {
          entity_id: "button.old_locate",
          device_id: DEVICE,
          disabled_by: "user",
        },
        "button.new_locate": {
          entity_id: "button.new_locate",
          device_id: DEVICE,
        },
      },
      {},
    );
    const endpoint = await mountLight("light.lamp4");
    calls.length = 0;

    await identify(endpoint);

    expect(calls).toEqual([
      { action: "button.press", target: "button.new_locate" },
    ]);
  });

  it("does not press on the effects that end an identification", async () => {
    setRegistry(
      {
        "light.lamp5": { entity_id: "light.lamp5", device_id: DEVICE },
        "button.press_me": { entity_id: "button.press_me", device_id: DEVICE },
      },
      { "button.press_me": { attributes: { device_class: "identify" } } },
    );
    const endpoint = await mountLight("light.lamp5");
    calls.length = 0;

    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive controller command
      const a = agent as any;
      // Blink starts one, StopEffect and FinishEffect end it.
      await a.identify.triggerEffect({ effectIdentifier: 0, effectVariant: 0 });
      await a.identify.triggerEffect({
        effectIdentifier: 0xfe,
        effectVariant: 0,
      });
      await a.identify.triggerEffect({
        effectIdentifier: 0xff,
        effectVariant: 0,
      });
    });

    expect(calls).toEqual([
      { action: "button.press", target: "button.press_me" },
    ]);
  });

  it("a plugin endpoint without any entity still identifies cleanly", async () => {
    // Plugin devices compose this same IdentifyServer but carry no HA entity.
    setRegistry({});
    const aggregator = await newServer();
    const type = createPluginEndpointType("on_off_plugin_unit");
    if (!type) throw new Error("no plugin endpoint type");
    // The exact shape onDeviceRegistered mounts.
    const part = new Endpoint(
      type.set({
        pluginDevice: {
          device: { id: "x", name: "Plugin thing", clusters: [] },
          pluginName: "p",
        },
        // biome-ignore lint/suspicious/noExplicitAny: plugin state fixture
      } as any),
      { id: "plugin_x" },
    );
    await aggregator.add(part);
    calls.length = 0;

    await expect(identify(part)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
