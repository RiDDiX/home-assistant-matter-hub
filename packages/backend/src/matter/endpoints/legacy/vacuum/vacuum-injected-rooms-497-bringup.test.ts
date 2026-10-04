import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
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
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import type { EntityEndpoint } from "../../entity-endpoint.js";
import { ServerModeVacuumEndpoint } from "../../server-mode-vacuum-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #497: Valetudo rooms come from sensor.*_map_segments and are added to the
// vacuum state only when the endpoint is built. The first raw HA update
// rebuilt the run modes without them, so controllers saw Idle and Cleaning.

const DEVICE = "vac-dev";
const VACUUM = "vacuum.valetudo_robo";
const SEGMENTS = "sensor.valetudo_robo_map_segments";

let dir: string;
let env: Environment;
let node: ServerNode | undefined;

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    area_id: null,
    categories: {},
    device_id: DEVICE,
    disabled_by: null,
    entity_category: null,
    entity_id: entityId,
    has_entity_name: false,
    hidden_by: null,
    id: entityId,
    labels: [],
    name: null,
    original_name: entityId,
    platform: "mqtt",
    translation_key: null,
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}

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
  return state(VACUUM, value, { friendly_name: "Robo", supported_features: 0 });
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

let liveStates: HomeAssistantStates;

function makeRegistry(): BridgeRegistry {
  liveStates = {
    [VACUUM]: vacuumState("docked"),
    [SEGMENTS]: state(SEGMENTS, "6", {
      "1": "Raum1",
      "2": "Raum2",
      "3": "Raum3",
      friendly_name: "Map segments",
    }),
  };
  const entities = Object.fromEntries(
    Object.keys(liveStates).map((id) => [id, registryEntity(id)]),
  );
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Robo" } },
    entities,
    labels: [],
    states: liveStates,
  } as unknown as HomeAssistantRegistry;
  env.set(EntityStateProvider, new EntityStateProvider(haRegistry));
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-injected-rooms-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantActions, { call() {}, fireEvent() {} } as any);
});

afterEach(async () => {
  await node?.close().catch(() => {});
  node = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function runModeLabels(endpoint: EntityEndpoint): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  return (endpoint.state as any).rvcRunMode.supportedModes.map(
    (m: { label: string }) => m.label,
  );
}

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

async function expectRoomsSurviveUpdate(
  endpoint: EntityEndpoint & {
    updateStates(states: HomeAssistantStates): Promise<void>;
  },
) {
  const rooms = ["Raum1", "Raum2", "Raum3"];
  expect(runModeLabels(endpoint)).toEqual(["Idle", "Cleaning", ...rooms]);

  liveStates[VACUUM] = vacuumState("cleaning");
  await endpoint.updateStates({ ...liveStates });
  await expect
    .poll(
      () =>
        // biome-ignore lint/suspicious/noExplicitAny: behavior state
        (endpoint.state as any).rvcRunMode.currentMode,
    )
    .toBe(1);

  expect(runModeLabels(endpoint)).toEqual(["Idle", "Cleaning", ...rooms]);
}

describe("Valetudo rooms after a Home Assistant update (#497)", () => {
  it("keeps the room run modes in server mode", async () => {
    const endpoint = await ServerModeVacuumEndpoint.create(
      makeRegistry(),
      VACUUM,
    );
    if (!endpoint) throw new Error("no endpoint");
    await (await newNode("rooms-server")).add(endpoint);
    await expectRoomsSurviveUpdate(endpoint);
  });

  it("keeps the room run modes in bridge mode", async () => {
    const endpoint = await LegacyEndpoint.create(makeRegistry(), VACUUM);
    if (!endpoint) throw new Error("no endpoint");
    const aggregator = new AggregatorEndpoint("aggregator");
    await (await newNode("rooms-bridge")).add(aggregator);
    await aggregator.add(endpoint);
    await expectRoomsSurviveUpdate(endpoint);
  });
});

// Same loss for HA 2026.3 CLEAN_AREA rooms: they live in the mapping, and the
// run modes were rebuilt from the vacuum attributes alone.
describe("CLEAN_AREA rooms (#497)", () => {
  it("keeps the HA area run modes after init and updates", async () => {
    const mapping = {
      entityId: VACUUM,
      cleanAreaRooms: [
        { areaId: 7, haAreaId: "living_room", name: "Living Room" },
        { areaId: 3, haAreaId: "kitchen", name: "Kitchen" },
      ],
    };
    const entity = (value: string) => ({
      entity_id: VACUUM,
      state: vacuumState(value),
    });
    const type = createLegacyEndpointType(entity("docked"), mapping);
    if (!type) throw new Error("no endpoint type");
    const aggregator = new AggregatorEndpoint("aggregator");
    await (await newNode("clean-area")).add(aggregator);
    const endpoint = new Endpoint(type, { id: "vacuum" });
    await aggregator.add(endpoint);
    const labels = ["Idle", "Cleaning", "Kitchen", "Living Room"];
    // biome-ignore lint/suspicious/noExplicitAny: behavior state
    const runModes = () => (endpoint.state as any).rvcRunMode.supportedModes;
    expect(runModes().map((m: { label: string }) => m.label)).toEqual(labels);

    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: entity("cleaning"),
    });
    expect(runModes().map((m: { label: string }) => m.label)).toEqual(labels);
  });
});
