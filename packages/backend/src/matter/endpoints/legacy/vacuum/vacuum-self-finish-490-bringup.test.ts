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

// #490: a controller room clean that docked on its own kept its rooms, and
// the next clean started from HA could only match those.

const ROOMS = [
  "Kitchen",
  "Living Room",
  "Hallway",
  "Dining Room", // 4
  "Office",
  "Bathroom",
  "Primary Bedroom", // 7
];
const KITCHEN = 1;
const DINING = 4;
const OFFICE = 5;
const BEDROOM = 7;

let dir: string;
let env: Environment;
let room: string;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-490-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  room = "unknown";
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

// mapping from the issue
const mapping: EntityMappingConfig = {
  entityId: "vacuum.robot",
  currentRoomEntity: "sensor.robot_room",
  customServiceAreas: ROOMS.map((name) => ({
    name,
    service: "script.clean_room",
    data: { room: name },
    batchDispatch: true,
  })),
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount() {
  const type = createLegacyEndpointType(vacuum("docked"), mapping);
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `n490-${counter++}`,
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

async function controllerClean(endpoint: Endpoint, areas: number[]) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).serviceArea.selectAreas({ newAreas: areas });
  });
  await controllerStart(endpoint);
}

function currentArea(endpoint: Endpoint): number | null {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  return (endpoint.state as any).serviceArea.currentArea;
}

function serviceArea(endpoint: Endpoint): {
  selectedAreas: number[];
  progress: ServiceArea.Progress[];
} {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  return (endpoint.state as any).serviceArea;
}

describe("#490 vacuum clean that finishes on its own", () => {
  it("lets a later Home Assistant clean track the room it is really in", async () => {
    const endpoint = await mount();

    await controllerClean(endpoint, [BEDROOM]);
    room = "Primary Bedroom";
    await haState(endpoint, "cleaning");
    expect(currentArea(endpoint)).toBe(BEDROOM);

    // docks on its own
    await haState(endpoint, "docked");
    expect(getSession(endpoint).activeAreas).toEqual([]);

    // started from HA
    room = "Dining Room";
    await haState(endpoint, "cleaning");

    expect(currentArea(endpoint)).toBe(DINING);
  });

  it("keeps the job going across a mid-job dock to recharge", async () => {
    const endpoint = await mount();

    await controllerClean(endpoint, [DINING, BEDROOM]);
    room = "Dining Room";
    await haState(endpoint, "cleaning");
    expect(currentArea(endpoint)).toBe(DINING);

    // recharge, bedroom still to go
    await haState(endpoint, "docked");
    expect(getSession(endpoint).activeAreas).toEqual([DINING, BEDROOM]);

    room = "Primary Bedroom";
    await haState(endpoint, "cleaning");
    expect(currentArea(endpoint)).toBe(BEDROOM);
    expect(getSession(endpoint).activeAreas).toEqual([DINING, BEDROOM]);
  });

  it("keeps a live controller job on its rooms while passing others", async () => {
    const endpoint = await mount();

    await controllerClean(endpoint, [BEDROOM]);
    room = "Kitchen";
    await haState(endpoint, "cleaning");

    // the robot really is in the kitchen (#501), the job stays the bedroom
    expect(currentArea(endpoint)).toBe(KITCHEN);
    expect(getSession(endpoint).activeAreas).toEqual([BEDROOM]);
    expect(serviceArea(endpoint).progress.map((p) => p.status)).toEqual([
      ServiceArea.OperationalStatus.Operating,
    ]);
  });
});

// #492: Apple Home kept showing "cleaning 3 rooms" for a one room clean
// started from HA after a three room controller job.
describe("#492 clean started outside Matter after a controller job", () => {
  const rooms = [KITCHEN, DINING, BEDROOM];

  async function threeRoomJob(endpoint: Endpoint) {
    await controllerClean(endpoint, rooms);
    for (const name of ["Kitchen", "Dining Room", "Primary Bedroom"]) {
      room = name;
      await haState(endpoint, "cleaning");
    }
    await haState(endpoint, "docked");
  }

  it("hides the old rooms while it runs and puts them back after", async () => {
    const endpoint = await mount();

    await threeRoomJob(endpoint);
    expect(serviceArea(endpoint).progress.map((p) => p.status)).toEqual([
      ServiceArea.OperationalStatus.Completed,
      ServiceArea.OperationalStatus.Completed,
      ServiceArea.OperationalStatus.Completed,
    ]);

    // one room, started from HA
    room = "Office";
    await haState(endpoint, "cleaning");
    expect(serviceArea(endpoint).selectedAreas).toEqual([]);
    expect(serviceArea(endpoint).progress).toEqual([]);
    expect(currentArea(endpoint)).toBe(OFFICE);

    await haState(endpoint, "docked");
    expect(serviceArea(endpoint).selectedAreas).toEqual(rooms);

    // Apple starts the same rooms again without re-sending them (#317)
    await controllerStart(endpoint);
    expect(getSession(endpoint).activeAreas).toEqual(rooms);
  });

  it("cleans the old rooms when Apple starts during the outside clean", async () => {
    const endpoint = await mount();

    await threeRoomJob(endpoint);
    room = "Office";
    await haState(endpoint, "cleaning");
    expect(serviceArea(endpoint).selectedAreas).toEqual([]);

    calls = [];
    await controllerStart(endpoint);
    expect(getSession(endpoint).activeAreas).toEqual(rooms);
    expect(serviceArea(endpoint).selectedAreas).toEqual(rooms);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      action: "script.clean_room",
      data: { selected_area_ids: rooms },
    });
  });

  it("does not bring back rooms the controller cleared meanwhile", async () => {
    const endpoint = await mount();

    await threeRoomJob(endpoint);
    room = "Office";
    await haState(endpoint, "cleaning");

    calls = [];
    await controllerClean(endpoint, []);
    expect(getSession(endpoint).activeAreas).toEqual([]);
    expect(calls).toEqual([{ action: "vacuum.start" }]);

    await haState(endpoint, "docked");
    expect(serviceArea(endpoint).selectedAreas).toEqual([]);
  });

  it("cleans the old rooms when Apple starts with a room mode", async () => {
    const endpoint = await mount();

    await threeRoomJob(endpoint);
    room = "Office";
    await haState(endpoint, "cleaning");

    // Apple sends a room mode after its picker, here without selectAreas
    calls = [];
    await controllerStart(endpoint, 103);
    expect(getSession(endpoint).activeAreas).toEqual(rooms);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      action: "script.clean_room",
      data: { selected_area_ids: rooms },
    });
  });

  it("keeps a stopped job's progress when HA reports cleaning late", async () => {
    const endpoint = await mount();

    await controllerClean(endpoint, rooms);
    room = "Kitchen";
    await haState(endpoint, "cleaning");
    await controllerStart(endpoint, RvcSupportedRunMode.Idle);
    const statuses = () => serviceArea(endpoint).progress.map((p) => p.status);
    const stopped = [
      ServiceArea.OperationalStatus.Completed,
      ServiceArea.OperationalStatus.Skipped,
      ServiceArea.OperationalStatus.Skipped,
    ];
    expect(statuses()).toEqual(stopped);

    // the vacuum still says cleaning for a moment after return_to_base
    await haState(endpoint, "cleaning");
    await haState(endpoint, "docked");
    expect(statuses()).toEqual(stopped);
    expect(serviceArea(endpoint).selectedAreas).toEqual(rooms);
  });

  it("keeps it too when the stop beats the first cleaning update", async () => {
    const endpoint = await mount();

    await controllerClean(endpoint, rooms);
    await controllerStart(endpoint, RvcSupportedRunMode.Idle);
    const stopped = serviceArea(endpoint).progress.map((p) => p.status);

    room = "Kitchen";
    await haState(endpoint, "cleaning");
    await haState(endpoint, "docked");
    expect(serviceArea(endpoint).progress.map((p) => p.status)).toEqual(
      stopped,
    );
    expect(serviceArea(endpoint).selectedAreas).toEqual(rooms);
  });
});
