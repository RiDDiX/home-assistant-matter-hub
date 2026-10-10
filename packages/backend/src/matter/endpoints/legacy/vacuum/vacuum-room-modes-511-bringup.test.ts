import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, type EndpointType, VendorId } from "@matter/main";
import { ModeBase } from "@matter/main/clusters";
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
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";
import { ServerModeVacuumDevice } from "./server-mode-vacuum-device.js";

// #511: Apple Home sends selectAreas([]) for "all rooms" and then starts with
// a room run mode, so HAMH cleaned that one room. disableCustomAreaRoomModes
// only removed the room modes for custom areas, not for CLEAN_AREA rooms or
// rooms from the vacuum attributes.

const VACUUM = "vacuum.roborock_q5";
const AREAS = [
  "Wohnzimmer",
  "Bad",
  "Diele OG",
  "Kueche",
  "Buero",
  "Schlafzimmer",
];
const cleanAreaRooms = AREAS.map((name, i) => ({
  areaId: i + 1,
  haAreaId: name.toLowerCase().replace(" ", "_"),
  name,
}));
const DIELE = 3;
const BAD = 2;

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-511-"));
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
    id: `n511-${counter++}`,
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

async function mountBridged(
  mapping: EntityMappingConfig,
  attributes: Record<string, unknown> = {},
) {
  const type = createLegacyEndpointType(vacuum("docked", attributes), mapping);
  if (!type) throw new Error("no endpoint type");
  const aggregator = new AggregatorEndpoint("aggregator");
  await (await newServer()).add(aggregator);
  const endpoint = new Endpoint(type, { id: "vacuum" });
  await aggregator.add(endpoint);
  return endpoint;
}

function modeLabels(endpoint: Endpoint): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  return (endpoint.state as any).rvcRunMode.supportedModes.map(
    (m: { label: string }) => m.label,
  );
}

function currentMode(endpoint: Endpoint): number {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  return (endpoint.state as any).rvcRunMode.currentMode;
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

const sorted = [...AREAS].sort((a, b) => a.localeCompare(b));

describe("CLEAN_AREA room modes (#511)", () => {
  it("cleans one room on Apple's all rooms start while room modes are on", async () => {
    const endpoint = await mountServerMode({
      entityId: VACUUM,
      cleanAreaRooms,
    });
    expect(modeLabels(endpoint)).toEqual(["Idle", "Cleaning", ...sorted]);
    expect(sorted[2]).toBe("Diele OG");

    // The reporter's log: selectAreas([]) then changeToMode(103)
    await selectAreas(endpoint, []);
    calls = [];
    await changeToMode(endpoint, 103);
    expect(calls).toEqual([
      { action: "vacuum.clean_area", data: { cleaning_area_id: ["diele_og"] } },
    ]);
  });

  for (const [name, mount] of [
    ["server mode", mountServerMode],
    ["bridge mode", mountBridged],
  ] as const) {
    it(`drops the room modes with the opt-in in ${name}`, async () => {
      const endpoint = await mount({
        entityId: VACUUM,
        cleanAreaRooms,
        disableCustomAreaRoomModes: true,
      });
      expect(modeLabels(endpoint)).toEqual(["Idle", "Cleaning"]);

      // update() ran: it set currentMode from the HA state
      await haState(endpoint, "cleaning");
      expect(currentMode(endpoint)).toBe(1);
      expect(modeLabels(endpoint)).toEqual(["Idle", "Cleaning"]);
      await haState(endpoint, "docked");
      expect(currentMode(endpoint)).toBe(0);
      expect(modeLabels(endpoint)).toEqual(["Idle", "Cleaning"]);

      // ServiceArea still lists every room
      expect(
        // biome-ignore lint/suspicious/noExplicitAny: behavior state
        (endpoint.state as any).serviceArea.supportedAreas.length,
      ).toBe(AREAS.length);
    });

    it(`starts a full clean for all rooms and clean_area for a subset in ${name}`, async () => {
      const endpoint = await mount({
        entityId: VACUUM,
        cleanAreaRooms,
        disableCustomAreaRoomModes: true,
      });

      // A room mode is no longer accepted
      calls = [];
      expect(await changeToMode(endpoint, 103)).toBe(
        ModeBase.ModeChangeStatus.UnsupportedMode,
      );
      expect(calls).toEqual([]);

      await selectAreas(endpoint, []);
      calls = [];
      expect(await changeToMode(endpoint, 1)).toBe(0);
      expect(calls).toEqual([{ action: "vacuum.start" }]);

      await changeToMode(endpoint, 0);
      await selectAreas(endpoint, [DIELE, BAD]);
      calls = [];
      expect(await changeToMode(endpoint, 1)).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ action: "vacuum.clean_area" });
      expect(
        [
          ...(calls[0].data as { cleaning_area_id: string[] }).cleaning_area_id,
        ].sort(),
      ).toEqual(["bad", "diele_og"]);
    });
  }
});

describe("attribute room modes (#511)", () => {
  const rooms = { "16": "Kitchen", "17": "Living Room", "18": "Hallway" };

  it("keeps them by default and drops them with the opt-in", async () => {
    const on = await mountServerMode({ entityId: VACUUM }, { rooms });
    expect(modeLabels(on)).toEqual([
      "Idle",
      "Cleaning",
      "Hallway",
      "Kitchen",
      "Living Room",
    ]);
    await server?.close();

    const off = await mountServerMode(
      { entityId: VACUUM, disableCustomAreaRoomModes: true },
      { rooms },
    );
    expect(modeLabels(off)).toEqual(["Idle", "Cleaning"]);
    await haState(off, "cleaning", { rooms });
    expect(currentMode(off)).toBe(1);
    expect(modeLabels(off)).toEqual(["Idle", "Cleaning"]);
  });
});
