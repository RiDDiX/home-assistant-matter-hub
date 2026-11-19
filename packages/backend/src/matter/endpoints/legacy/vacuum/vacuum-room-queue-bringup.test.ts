import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import {
  getSession,
  RvcSupportedRunMode,
} from "../../../behaviors/rvc-run-mode-server.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

// One room per command: the queue fires the next room when the robot
// goes from cleaning to idle.

const ROOMS = ["Kitchen", "Living Room", "Hallway"];

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-queue-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call: (a: HomeAssistantAction) => calls.push(a),
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
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantConfig, { unitSystem: { temperature: "°C" } } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function vacuum(state: string): HomeAssistantEntityInformation {
  const s = {
    entity_id: "vacuum.robot",
    state,
    attributes: { friendly_name: "Robot", supported_features: 0 },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: new Date().toISOString(),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "vacuum.robot", state: s as any };
}

const mapping: EntityMappingConfig = {
  entityId: "vacuum.robot",
  customServiceAreas: ROOMS.map((name) => ({
    name,
    service: "script.clean_room",
    data: { room: name },
  })),
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount() {
  const type = createLegacyEndpointType(vacuum("docked"), mapping);
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `nqueue-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "vacuum" });
  await aggregator.add(endpoint);
  return endpoint;
}

async function haState(endpoint: Endpoint, state: string) {
  await endpoint.setStateOf(HomeAssistantEntityBehavior, {
    entity: vacuum(state),
  });
  await delay(40);
}

async function controllerClean(endpoint: Endpoint, areas: number[]) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).serviceArea.selectAreas({ newAreas: areas });
  });
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).rvcRunMode.changeToMode({
      newMode: RvcSupportedRunMode.Cleaning,
    });
  });
}

describe("sequential room queue end", () => {
  it.each(["idle", "returning"])("sends the next room on %s", async (state) => {
    const endpoint = await mount();
    await controllerClean(endpoint, [1, 2, 3]);
    await haState(endpoint, "cleaning");
    calls = [];

    await haState(endpoint, state);

    expect(calls).toEqual([
      { action: "script.clean_room", data: { room: "Living Room" } },
    ]);
    expect(getSession(endpoint).pendingDispatches).toHaveLength(1);
  });

  it("sends no further room when the robot reports an error", async () => {
    const endpoint = await mount();
    await controllerClean(endpoint, [1, 2, 3]);
    await haState(endpoint, "cleaning");
    expect(getSession(endpoint).pendingDispatches).toHaveLength(2);
    calls = [];

    await haState(endpoint, "error");
    await haState(endpoint, "docked");
    await haState(endpoint, "cleaning");
    await haState(endpoint, "returning");

    expect(calls).toEqual([]);
    expect(getSession(endpoint).pendingDispatches).toEqual([]);
  });

  it("drops a queue that never started when a plain clean follows", async () => {
    const endpoint = await mount();
    // the robot ignores the first room, HA never reports cleaning
    await controllerClean(endpoint, [1, 2, 3]);
    await haState(endpoint, "docked");
    expect(getSession(endpoint).pendingDispatches).toHaveLength(2);
    calls = [];

    await controllerClean(endpoint, []);
    await haState(endpoint, "cleaning");
    await haState(endpoint, "returning");

    expect(calls).toEqual([{ action: "vacuum.start" }]);
    expect(getSession(endpoint).pendingDispatches).toEqual([]);
    expect(getSession(endpoint).activeAreas).toEqual([]);
  });
});
