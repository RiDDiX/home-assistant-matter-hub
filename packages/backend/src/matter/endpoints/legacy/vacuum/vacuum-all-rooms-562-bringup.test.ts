import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServiceArea } from "@matter/main/clusters";
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

// #562: an all-rooms start from Apple Home (selectAreas([]) then Cleaning)
// left progress empty, so Apple showed Preparing for the whole job.

const KITCHEN = 1;
const LIVING = 2;
const { Pending, Operating, Completed, Skipped } =
  ServiceArea.OperationalStatus;

let dir: string;
let env: Environment;
let room: string;
let sqm: number;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-562-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  room = "unknown";
  sqm = 0;
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
    getState: (id: string) =>
      id === "sensor.robot_room"
        ? { entity_id: id, state: room, attributes: {} }
        : undefined,
    getNumericState: (id: string) =>
      id === "sensor.cleaned_area" ? sqm : null,
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

// mapping from the issue: two batch areas with sizes, cleaned area sensor
const areas = ["Kitchen", "Living Room"].map((name) => ({
  name,
  sizeSqm: 10,
  service: "script.clean_room",
  data: { room: name },
  batchDispatch: true,
}));
const issueMapping: EntityMappingConfig = {
  entityId: "vacuum.robot",
  cleanedAreaEntity: "sensor.cleaned_area",
  disableCustomAreaRoomModes: true,
  customServiceAreas: areas,
};
const roomSensorMapping: EntityMappingConfig = {
  entityId: "vacuum.robot",
  currentRoomEntity: "sensor.robot_room",
  disableCustomAreaRoomModes: true,
  customServiceAreas: areas,
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(m: EntityMappingConfig) {
  const type = createLegacyEndpointType(vacuum("docked"), m);
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `n562-${counter++}`,
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

async function controllerStart(
  endpoint: Endpoint,
  newMode: number = RvcSupportedRunMode.Cleaning,
) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).rvcRunMode.changeToMode({ newMode });
  });
}

async function controllerClean(endpoint: Endpoint, selected: number[]) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).serviceArea.selectAreas({ newAreas: selected });
  });
  await controllerStart(endpoint);
}

function serviceArea(endpoint: Endpoint): {
  selectedAreas: number[];
  currentArea: number | null;
  progress: ServiceArea.Progress[];
} {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  return (endpoint.state as any).serviceArea;
}

const statuses = (endpoint: Endpoint) =>
  serviceArea(endpoint).progress.map((p) => p.status);

describe("#562 all-rooms start from a controller", () => {
  it("lists every area as pending without a selection or a room", async () => {
    const endpoint = await mount(issueMapping);

    await controllerClean(endpoint, []);
    await haState(endpoint, "cleaning");

    expect(calls).toEqual([{ action: "vacuum.start" }]);
    expect(serviceArea(endpoint).selectedAreas).toEqual([]);
    expect(serviceArea(endpoint).currentArea).toBeNull();
    expect(serviceArea(endpoint).progress).toEqual([
      { areaId: KITCHEN, status: Pending },
      { areaId: LIVING, status: Pending },
    ]);

    // no sensor ever marks a room, so the unvisited ones are cleared
    await haState(endpoint, "docked");
    expect(serviceArea(endpoint).progress).toEqual([]);
    expect(serviceArea(endpoint).currentArea).toBeNull();
    expect(getSession(endpoint).activeAreas).toEqual([]);
    expect(getSession(endpoint).wholeHome).toBe(false);
  });

  it("keeps the job while HA still reports docked after the start", async () => {
    const endpoint = await mount(issueMapping);

    await controllerClean(endpoint, []);
    await haState(endpoint, "docked");
    expect(getSession(endpoint).wholeHome).toBe(true);
    expect(statuses(endpoint)).toEqual([Pending, Pending]);

    await haState(endpoint, "cleaning");
    expect(getSession(endpoint).wholeHome).toBe(true);
    expect(statuses(endpoint)).toEqual([Pending, Pending]);
  });

  it("leaves a vacuum without rooms as before", async () => {
    const endpoint = await mount({ entityId: "vacuum.robot" });
    expect(serviceArea(endpoint).progress).toEqual([]);

    await controllerClean(endpoint, []);
    await haState(endpoint, "cleaning");

    expect(getSession(endpoint).wholeHome).toBeFalsy();
    expect(getSession(endpoint).activeAreas).toEqual([]);
    expect(serviceArea(endpoint).progress).toEqual([]);
  });

  it("does not guess a room from the cleaned area sensor", async () => {
    const endpoint = await mount(issueMapping);

    await controllerClean(endpoint, []);
    sqm = 3;
    await haState(endpoint, "cleaning");
    sqm = 12;
    await haState(endpoint, "cleaning");

    expect(serviceArea(endpoint).currentArea).toBeNull();
    expect(statuses(endpoint)).toEqual([Pending, Pending]);
  });

  it("follows a current room sensor", async () => {
    const endpoint = await mount(roomSensorMapping);

    await controllerClean(endpoint, []);
    room = "Living Room";
    await haState(endpoint, "cleaning");
    expect(serviceArea(endpoint).currentArea).toBe(LIVING);
    expect(statuses(endpoint)).toEqual([Pending, Operating]);

    room = "Kitchen";
    await haState(endpoint, "cleaning");
    expect(serviceArea(endpoint).currentArea).toBe(KITCHEN);
    expect(statuses(endpoint)).toEqual([Operating, Completed]);

    await haState(endpoint, "docked");
    expect(serviceArea(endpoint).currentArea).toBeNull();
    expect(statuses(endpoint)).toEqual([Completed, Completed]);
  });

  it("ends on dock before every room, a later HA clean stays external", async () => {
    const endpoint = await mount(roomSensorMapping);

    await controllerClean(endpoint, []);
    room = "Kitchen";
    await haState(endpoint, "cleaning");
    await haState(endpoint, "docked");

    expect(serviceArea(endpoint).currentArea).toBeNull();
    expect(serviceArea(endpoint).progress).toEqual([]);
    expect(getSession(endpoint).activeAreas).toEqual([]);
    expect(getSession(endpoint).wholeHome).toBe(false);

    // started from HA
    room = "Living Room";
    await haState(endpoint, "cleaning");
    expect(serviceArea(endpoint).selectedAreas).toEqual([]);
    expect(serviceArea(endpoint).progress).toEqual([]);
    expect(serviceArea(endpoint).currentArea).toBe(LIVING);
    expect(getSession(endpoint).activeAreas).toEqual([]);
  });

  it("ends on a controller stop", async () => {
    const endpoint = await mount(roomSensorMapping);

    await controllerClean(endpoint, []);
    room = "Kitchen";
    await haState(endpoint, "cleaning");
    await controllerStart(endpoint, RvcSupportedRunMode.Idle);

    expect(statuses(endpoint)).toEqual([Completed, Skipped]);
    expect(serviceArea(endpoint).currentArea).toBeNull();
    expect(getSession(endpoint).activeAreas).toEqual([]);
    expect(getSession(endpoint).wholeHome).toBe(false);
  });

  it("keeps a one room selection as before", async () => {
    const endpoint = await mount(issueMapping);

    await controllerClean(endpoint, [LIVING]);
    await haState(endpoint, "cleaning");

    expect(serviceArea(endpoint).selectedAreas).toEqual([LIVING]);
    expect(serviceArea(endpoint).currentArea).toBe(LIVING);
    expect(serviceArea(endpoint).progress).toEqual([
      { areaId: LIVING, status: Operating },
    ]);
    expect(getSession(endpoint).wholeHome).toBe(false);
  });
});
