import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServiceArea } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../../services/home-assistant/home-assistant-registry.js";
import {
  getSession,
  RvcSupportedRunMode,
} from "../../../behaviors/rvc-run-mode-server.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ServerModeVacuumEndpoint } from "../../server-mode-vacuum-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #501: a Dreame in server mode, Apple Home job on rooms 6, 9 and 12.

const DEVICE = "vac-dev";
const VACUUM = "vacuum.robot";
const ROOM = "sensor.robot_current_room";
const NAMES: Record<number, string> = {
  6: "Kitchen",
  9: "Office",
  10: "Hallway",
  12: "Bedroom",
  13: "Bathroom",
};
const { Operating, Pending, Completed, Skipped } =
  ServiceArea.OperationalStatus;

let dir: string;
let env: Environment;
let node: ServerNode | undefined;
let liveStates: HomeAssistantStates;
let names: Record<number, string>;

function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes,
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: new Date().toISOString(),
  };
}

function vacuumState(value: string): HomeAssistantEntityState {
  return state(VACUUM, value, {
    friendly_name: "Robot",
    supported_features: 0,
    rooms: {
      "Map 1": Object.entries(names).map(([id, name]) => ({
        id: Number(id),
        name,
      })),
    },
  });
}

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    device_id: DEVICE,
    entity_id: entityId,
    id: entityId,
    original_name: entityId,
    platform: "dreame_vacuum",
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}

function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
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
  } as any);
}

function makeRegistry(): BridgeRegistry {
  liveStates = {
    [VACUUM]: vacuumState("docked"),
    [ROOM]: state(ROOM, "unknown"),
  };
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Robot" } },
    entities: {
      [VACUUM]: registryEntity(VACUUM),
      [ROOM]: registryEntity(ROOM),
    },
    labels: [],
    states: liveStates,
  } as unknown as HomeAssistantRegistry;
  env.set(EntityStateProvider, new EntityStateProvider(haRegistry));
  return new BridgeRegistry(haRegistry, dataProvider());
}

const mapping: EntityMappingConfig = {
  entityId: VACUUM,
  currentRoomEntity: ROOM,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-501-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantActions, { call() {}, fireEvent() {} } as any);
  names = { ...NAMES };
});

afterEach(async () => {
  await node?.close().catch(() => {});
  node = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function newNode(id: string) {
  node = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  return node;
}

type VacuumEndpoint = ServerModeVacuumEndpoint | LegacyEndpoint;

async function serverMode(id: string): Promise<VacuumEndpoint> {
  const endpoint = await ServerModeVacuumEndpoint.create(
    makeRegistry(),
    VACUUM,
    mapping,
  );
  if (!endpoint) throw new Error("no endpoint");
  await (await newNode(id)).add(endpoint);
  return endpoint;
}

async function bridgeMode(id: string): Promise<VacuumEndpoint> {
  const endpoint = await LegacyEndpoint.create(makeRegistry(), VACUUM, mapping);
  if (!endpoint) throw new Error("no endpoint");
  const aggregator = new AggregatorEndpoint("aggregator");
  await (await newNode(id)).add(aggregator);
  await aggregator.add(endpoint);
  return endpoint;
}

function serviceArea(endpoint: VacuumEndpoint): {
  supportedAreas: ServiceArea.Area[];
  selectedAreas: number[];
  currentArea: number | null;
  progress: ServiceArea.Progress[];
} {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  return (endpoint.state as any).serviceArea;
}

const statuses = (endpoint: VacuumEndpoint) =>
  serviceArea(endpoint).progress.map((p) => p.status);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function push(endpoint: VacuumEndpoint, vacuum: string) {
  liveStates[VACUUM] = vacuumState(vacuum);
  await endpoint.updateStates({ ...liveStates });
  await delay(150);
}

/** The robot drives into a room while HA reports it cleaning. */
async function enter(endpoint: VacuumEndpoint, areaId: number) {
  liveStates[ROOM] = state(ROOM, names[areaId], { room_id: areaId });
  await push(endpoint, "cleaning");
  expect(serviceArea(endpoint).currentArea).toBe(areaId);
}

async function controllerClean(endpoint: VacuumEndpoint, areas: number[]) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).serviceArea.selectAreas({ newAreas: areas });
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).rvcRunMode.changeToMode({
      newMode: RvcSupportedRunMode.Cleaning,
    });
  });
}

describe("#501 current room during a controller job", () => {
  it("follows the robot through rooms it was not asked to clean", async () => {
    const endpoint = await serverMode("n501-transit");
    await controllerClean(endpoint, [6, 9, 12]);

    await enter(endpoint, 6);
    expect(statuses(endpoint)).toEqual([Operating, Pending, Pending]);

    // passing through the hallway finishes nothing
    await enter(endpoint, 10);
    expect(statuses(endpoint)).toEqual([Operating, Pending, Pending]);
    expect([...getSession(endpoint).completedAreas]).toEqual([]);

    // and coming back to the kitchen does not either
    await enter(endpoint, 6);
    expect(statuses(endpoint)).toEqual([Operating, Pending, Pending]);
    expect([...getSession(endpoint).completedAreas]).toEqual([]);

    await enter(endpoint, 9);
    expect(statuses(endpoint)).toEqual([Completed, Operating, Pending]);

    await enter(endpoint, 13);
    expect(statuses(endpoint)).toEqual([Completed, Operating, Pending]);

    await enter(endpoint, 12);
    expect(statuses(endpoint)).toEqual([Completed, Completed, Operating]);

    // docked on its own, the job is done and cleared (#490)
    await push(endpoint, "docked");
    expect(statuses(endpoint)).toEqual([Completed, Completed, Completed]);
    expect(serviceArea(endpoint).currentArea).toBeNull();
    expect(getSession(endpoint).activeAreas).toEqual([]);
  });

  it("counts the room it left as cleaned on a stop in transit", async () => {
    const endpoint = await serverMode("n501-stop");
    await controllerClean(endpoint, [6, 9]);
    await enter(endpoint, 6);
    await enter(endpoint, 10);

    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      await (agent as any).rvcRunMode.changeToMode({
        newMode: RvcSupportedRunMode.Idle,
      });
    });
    expect(statuses(endpoint)).toEqual([Completed, Skipped]);
  });
});

describe("#501 room renamed in the vacuum integration", () => {
  for (const [label, mount] of [
    ["server", serverMode],
    ["bridge", bridgeMode],
  ] as const) {
    it(`relabels the area in place in ${label} mode`, async () => {
      const endpoint = await mount(`n501-rename-${label}`);
      await endpoint.act(async (agent) => {
        // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
        await (agent as any).serviceArea.selectAreas({ newAreas: [9, 12] });
      });
      const before = serviceArea(endpoint).supportedAreas;
      expect(
        before.find((a) => a.areaId === 9)?.areaInfo.locationInfo?.locationName,
      ).toBe("Office");

      names[9] = "Study";
      await push(endpoint, "docked");

      const after = serviceArea(endpoint).supportedAreas;
      expect(after.map((a) => [a.areaId, a.mapId])).toEqual(
        before.map((a) => [a.areaId, a.mapId]),
      );
      expect(after.map((a) => a.areaInfo.locationInfo?.locationName)).toEqual([
        "Kitchen",
        "Study",
        "Hallway",
        "Bedroom",
        "Bathroom",
      ]);
      expect(serviceArea(endpoint).selectedAreas).toEqual([9, 12]);

      // unavailable puts the build snapshot's rooms back, so the rename has to stay
      liveStates[VACUUM] = state(VACUUM, "unavailable", {
        friendly_name: "Robot",
      });
      await endpoint.updateStates({ ...liveStates });
      await delay(150);
      expect(
        serviceArea(endpoint).supportedAreas.find((a) => a.areaId === 9)
          ?.areaInfo.locationInfo?.locationName,
      ).toBe("Study");
    });
  }
});
