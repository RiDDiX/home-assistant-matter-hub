import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, type EndpointType, VendorId } from "@matter/main";
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
import { ServerModeVacuumDevice } from "./server-mode-vacuum-device.js";

// Room mode labels must be unique, so repeated or reserved room names get a
// suffix the area name lacks. The endpoint has to come up and a room mode
// start has to find its area anyway. The clean mode keeps a pending change
// across transactions.

const VACUUM = "vacuum.roborock_q5";

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-labels-"));
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
      },
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

function vacuum(
  state: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityInformation {
  const s = {
    entity_id: VACUUM,
    state,
    attributes: { friendly_name: "Robo", supported_features: 0, ...attributes },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: new Date().toISOString(),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: VACUUM, state: s as any };
}

async function newServer() {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `nlabels-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  return server;
}

async function mountServerMode(
  mapping: EntityMappingConfig,
  attributes: Record<string, unknown> = {},
) {
  const type = ServerModeVacuumDevice({
    entity: vacuum("docked", attributes),
    mapping,
  } as HomeAssistantEntityBehavior.State);
  if (!type) throw new Error("no endpoint type");
  const endpoint = new Endpoint(type as EndpointType, { id: "vacuum" });
  await (await newServer()).add(endpoint);
  return endpoint;
}

function modeLabels(endpoint: Endpoint): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  return (endpoint.state as any).rvcRunMode.supportedModes.map(
    (m: { label: string }) => m.label,
  );
}

async function haState(
  endpoint: Endpoint,
  state: string,
  attributes: Record<string, unknown> = {},
) {
  await endpoint.setStateOf(HomeAssistantEntityBehavior, {
    entity: vacuum(state, attributes),
  });
}

async function selectAreas(endpoint: Endpoint, newAreas: number[]) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).serviceArea.selectAreas({ newAreas });
  });
}

async function changeToMode(endpoint: Endpoint, newMode: number) {
  let status: number | undefined;
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    const res = await (agent as any).rvcRunMode.changeToMode({ newMode });
    status = res.status;
  });
  return status;
}

function modeOf(endpoint: Endpoint, label: string): number {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  const modes = (endpoint.state as any).rvcRunMode.supportedModes as {
    label: string;
    mode: number;
  }[];
  const mode = modes.find((m) => m.label === label)?.mode;
  if (mode === undefined) throw new Error(`no mode ${label}`);
  return mode;
}

function currentArea(endpoint: Endpoint): number | null {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  return (endpoint.state as any).serviceArea.currentArea;
}

describe("room mode labels", () => {
  it("mounts with two attribute rooms of the same name", async () => {
    const endpoint = await mountServerMode(
      { entityId: VACUUM },
      {
        room_mapping: [
          [16, "a", "Bedroom"],
          [17, "b", "Bedroom"],
        ],
      },
    );
    expect(modeLabels(endpoint)).toEqual([
      "Idle",
      "Cleaning",
      "Bedroom",
      "Bedroom 2",
    ]);

    await selectAreas(endpoint, []);
    await changeToMode(endpoint, modeOf(endpoint, "Bedroom 2"));
    expect(currentArea(endpoint)).toBe(17);
  });

  it("mounts with an attribute room named Cleaning", async () => {
    const endpoint = await mountServerMode(
      { entityId: VACUUM },
      { rooms: { "1": "Cleaning", "2": "Kitchen" } },
    );
    expect(modeLabels(endpoint)).toEqual([
      "Idle",
      "Cleaning",
      "Cleaning 1",
      "Kitchen",
    ]);
  });

  it("cleans the right CLEAN_AREA room behind a suffixed label", async () => {
    const long = "\u5ba2".repeat(30);
    const endpoint = await mountServerMode({
      entityId: VACUUM,
      cleanAreaRooms: [
        { areaId: 1, haAreaId: "kitchen", name: "Kitchen" },
        { areaId: 2, haAreaId: "cleaning", name: "Cleaning" },
        { areaId: 3, haAreaId: "long", name: long },
      ],
    });
    const labels = modeLabels(endpoint);
    expect(labels.every((l) => Buffer.byteLength(l) <= 64)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);

    await selectAreas(endpoint, []);
    calls = [];
    await changeToMode(endpoint, modeOf(endpoint, "Cleaning 1"));
    expect(calls).toEqual([
      { action: "vacuum.clean_area", data: { cleaning_area_id: ["cleaning"] } },
    ]);
    expect(currentArea(endpoint)).toBe(2);
  });

  it("finds the custom area behind a map suffixed label (#506)", async () => {
    const endpoint = await mountServerMode({
      entityId: VACUUM,
      customServiceAreas: [
        { name: "Bath", service: "script.bath_down", mapName: "Ground" },
        { name: "Bath", service: "script.bath_up", mapName: "Upstairs" },
        { name: "Hall", service: "script.hall", mapName: "Ground" },
      ],
    });

    await selectAreas(endpoint, []);
    calls = [];
    await changeToMode(endpoint, modeOf(endpoint, "Bath (Upstairs)"));
    expect(calls).toMatchObject([{ action: "script.bath_up" }]);
    expect(currentArea(endpoint)).toBe(2);
  });
});

describe("clean mode pending change", () => {
  const fan = { fan_speed_list: ["Silent", "Standard", "Strong"] };

  function cleanMode(endpoint: Endpoint): number {
    // biome-ignore lint/suspicious/noExplicitAny: behavior state
    return (endpoint.state as any).rvcCleanMode.currentMode;
  }

  it("keeps the new mode over a stale HA update in a later transaction", async () => {
    const endpoint = await mountServerMode(
      { entityId: VACUUM },
      { ...fan, fan_speed: "Silent" },
    );
    const before = cleanMode(endpoint);
    // biome-ignore lint/suspicious/noExplicitAny: behavior state
    const target = (endpoint.state as any).rvcCleanMode.supportedModes.find(
      (m: { label: string }) =>
        m.label.includes("Strong") || m.label.includes("Max"),
    )?.mode as number;
    expect(target).toBeDefined();
    expect(target).not.toBe(before);

    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      await (agent as any).rvcCleanMode.changeToMode({ newMode: target });
    });
    await haState(endpoint, "docked", { ...fan, fan_speed: "Silent" });
    expect(cleanMode(endpoint)).toBe(target);

    await haState(endpoint, "docked", { ...fan, fan_speed: "Strong" });
    expect(cleanMode(endpoint)).toBe(target);
    await haState(endpoint, "docked", { ...fan, fan_speed: "Silent" });
    expect(cleanMode(endpoint)).toBe(before);
  });
});
