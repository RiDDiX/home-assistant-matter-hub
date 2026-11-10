import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import type { DataNamespace } from "@matter/general";
import { Environment, StorageService, VariableService } from "@matter/general";
import { Endpoint, type EndpointType, VendorId } from "@matter/main";
import { FanControl } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CustomStorage } from "../../../../core/app/storage/custom-storage.js";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { updateEntityState } from "../../update-entity-state.js";
import { HumidifierDevice } from "../humidifier/index.js";
import { FanDevice } from "./index.js";

// #546: a Dyson in preset Auto reports state "on" with percentage null.
// FanControl read that as speed 0 and said fanMode Off while OnOff said on,
// so Apple Home hung on "Turning...". Same for a humidifier without humidity.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-fan-546-"));
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

function entity(
  entityId: string,
  state: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const full = {
    entity_id: entityId,
    state,
    attributes: { friendly_name: "Test", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: full as any };
}

async function bringUp(
  device: (e: never) => EndpointType,
  initial: HomeAssistantEntityInformation,
) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fan-546-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    device({ entity: initial, mapping: undefined } as never),
    { id: "dev" },
  );
  await aggregator.add(endpoint);
  const push = async (next: HomeAssistantEntityInformation) => {
    await updateEntityState(endpoint, next.state);
    // let the post-commit reactor finish
    await new Promise((r) => setTimeout(r, 50));
  };
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  const read = (cluster: string) => endpoint.stateOf(cluster as any) as any;
  return { server, endpoint, push, read };
}

// Restart on the production storage, like the #387 restart test.
function useProductionStorage() {
  const storageService = env.get(StorageService);
  storageService.registerDriver({
    id: CustomStorage.driverId,
    async create(namespace: DataNamespace) {
      const driver = new CustomStorage(namespace);
      await driver.initialize();
      return driver;
    },
  });
  storageService.defaultDriver = CustomStorage.driverId;
}

// Session 1 mounts `before` and closes, session 2 mounts the fan off on the
// same storage and a controller turns it on.
async function turnOnAfterRestart(before: HomeAssistantEntityInformation) {
  useProductionStorage();
  const first = await bringUp(FanDevice, before);
  await first.server.close().catch(() => {});

  const off = entity(before.entity_id, "off", {
    ...before.state.attributes,
    percentage: 0,
  });
  const second = await bringUp(FanDevice, off);
  const memory = { ...second.read("fanSpeedMemory") };
  calls.length = 0;
  await second.endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    const a = agent as any;
    await a.onOff.on();
    // act() has no subject, so hand the reactor a controller context
    a.fanControl.onOffChanged(true, false, { subject: {} });
  });
  await new Promise((r) => setTimeout(r, 50));
  await second.server.close().catch(() => {});
  return { memory, actions: calls.map((c) => c.action) };
}

const dyson = {
  supported_features: 63,
  preset_modes: ["Auto", "Normal"],
  percentage_step: 10,
};

describe("on fan without a percentage (#546)", () => {
  it("a. Dyson in preset Auto reports Auto and a speed", async () => {
    const { server, push, read } = await bringUp(
      FanDevice,
      entity("fan.dyson", "off", { ...dyson, percentage: 0 }),
    );
    await push(
      entity("fan.dyson", "on", {
        ...dyson,
        preset_mode: "Auto",
        percentage: null,
      }),
    );
    const fc = read("fanControl");
    const onOff = read("onOff");
    await server.close().catch(() => {});

    expect(fc.fanMode).toBe(FanControl.FanMode.Auto);
    expect(fc.percentSetting).toBeGreaterThan(0);
    expect(fc.speedSetting).toBeGreaterThan(0);
    expect(onOff.onOff).toBe(true);
    expect(calls).toEqual([]);
  });

  it("b. plain fan on without percentage is not Off", async () => {
    const attrs = { supported_features: 1, percentage_step: 1 };
    const { server, push, read } = await bringUp(
      FanDevice,
      entity("fan.plain", "off", { ...attrs, percentage: 0 }),
    );
    await push(entity("fan.plain", "on", { ...attrs, percentage: null }));
    const fc = read("fanControl");
    await server.close().catch(() => {});

    expect(fc.fanMode).not.toBe(FanControl.FanMode.Off);
    expect(fc.percentSetting).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it("c. keeps the last real percentage and remembers it", async () => {
    const attrs = { supported_features: 1, percentage_step: 1 };
    const { server, push, read } = await bringUp(
      FanDevice,
      entity("fan.plain", "on", { ...attrs, percentage: 40 }),
    );
    await push(entity("fan.plain", "on", { ...attrs, percentage: null }));
    const fc = read("fanControl");
    const memory = read("fanSpeedMemory");
    await server.close().catch(() => {});

    expect(fc.percentSetting).toBe(40);
    expect(memory.lastPercent).toBe(40);
    expect(calls).toEqual([]);
  });

  it("c. never remembers the fallback speed", async () => {
    const attrs = { supported_features: 1, percentage_step: 1 };
    const { server, push, read } = await bringUp(
      FanDevice,
      entity("fan.plain", "off", { ...attrs, percentage: 0 }),
    );
    await push(entity("fan.plain", "on", { ...attrs, percentage: null }));
    const fc = read("fanControl");
    const memory = read("fanSpeedMemory");
    await server.close().catch(() => {});

    expect(fc.percentSetting).toBeGreaterThan(0);
    expect(memory.lastPercent).toBe(0);
    expect(calls).toEqual([]);
  });

  it("d. off fan with a stale Auto preset still reports Off (#219)", async () => {
    const { server, push, read } = await bringUp(
      FanDevice,
      entity("fan.dyson", "on", {
        ...dyson,
        preset_mode: "Auto",
        percentage: 50,
      }),
    );
    await push(
      entity("fan.dyson", "off", {
        ...dyson,
        preset_mode: "Auto",
        percentage: null,
      }),
    );
    const fc = read("fanControl");
    await server.close().catch(() => {});

    expect(fc.fanMode).toBe(FanControl.FanMode.Off);
    expect(fc.percentSetting).toBe(0);
    expect(calls).toEqual([]);
  });

  it("e. humidifier on without humidity keeps percentSetting 0", async () => {
    const attrs = { available_modes: ["normal", "eco"], mode: "normal" };
    const { server, push, read } = await bringUp(
      HumidifierDevice,
      entity("humidifier.test", "off", attrs),
    );
    await push(entity("humidifier.test", "on", attrs));
    const fc = read("fanControl");
    const onOff = read("onOff");
    await server.close().catch(() => {});

    expect(onOff.onOff).toBe(true);
    expect(fc.percentSetting).toBe(0);
    expect(calls).toEqual([]);
  });

  it("f. the stand-in does not reach speed memory after a restart", async () => {
    const { memory, actions } = await turnOnAfterRestart(
      entity("fan.dyson", "on", {
        ...dyson,
        preset_mode: "Auto",
        percentage: null,
      }),
    );

    expect(memory.lastPercent).toBe(0);
    expect(actions).toContain("fan.turn_on");
    expect(actions).not.toContain("fan.set_percentage");
  });

  it("f. a real remembered speed survives a restart", async () => {
    const { memory, actions } = await turnOnAfterRestart(
      entity("fan.plain", "on", {
        supported_features: 1,
        percentage_step: 1,
        percentage: 40,
      }),
    );

    expect(memory.lastPercent).toBe(40);
    expect(actions).toContain("fan.set_percentage");
    const setPct = calls.find((c) => c.action === "fan.set_percentage");
    expect(setPct?.data).toMatchObject({ percentage: 40 });
  });
});
