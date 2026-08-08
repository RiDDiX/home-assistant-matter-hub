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
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// Doorbell (0x148) is opt-in per entity. The default event mapping stays
// GenericSwitch so existing pairings keep their composition.

const DOORBELL = 0x148;
const GENERIC_SWITCH = 0x000f;
const BRIDGED_NODE = 0x0013;

const DEVICE = "dev1";
const ENTITY = "event.front_door";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let firedEvents: Array<{ type: string; data?: Record<string, unknown> }>;

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
    platform: "test",
    translation_key: null,
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}

function state(
  value: string,
  eventType: string | null,
): HomeAssistantEntityState {
  return {
    entity_id: ENTITY,
    state: value,
    attributes: {
      device_class: "doorbell",
      event_types: ["pressed"],
      event_type: eventType,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
    context: { id: "ctx" },
    last_changed: value,
    last_updated: value,
  };
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
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any);
}

function registry(): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [ENTITY]: state("2026-01-01T00:00:00", null),
  };
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Doorbell" } },
    entities: { [ENTITY]: registryEntity(ENTITY) },
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-doorbell-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  firedEvents = [];
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    fireEvent(type: string, data?: Record<string, unknown>) {
      firedEvents.push({ type, data });
    },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(mapping: EntityMappingConfig) {
  const endpoint = await LegacyEndpoint.create(registry(), ENTITY, mapping);
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `doorbell-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint!);
  await delay(50);
  return endpoint!;
}

describe("doorbell override bring-up (#419)", () => {
  it("mounts 0x148 with the momentary switch cluster and relays a press", async () => {
    const endpoint = await mount({
      entityId: ENTITY,
      matterDeviceType: "doorbell",
    });

    // biome-ignore lint/suspicious/noExplicitAny: read runtime state
    const st = endpoint.state as any;
    const entries = (
      st.descriptor.deviceTypeList as Array<{
        deviceType: number;
        revision: number;
      }>
    ).map((d) => ({
      deviceType: Number(d.deviceType),
      revision: Number(d.revision),
    }));
    expect(entries).toContainEqual({ deviceType: DOORBELL, revision: 2 });
    expect(entries.map((e) => e.deviceType)).toContain(BRIDGED_NODE);

    // Mandatory Switch attributes with the MomentarySwitch feature.
    expect(st.switch.numberOfPositions).toBe(2);
    expect(st.switch.currentPosition).toBe(0);
    expect(st.switch.featureMap.momentarySwitch).toBe(true);

    // An HA doorbell event must drive the switch behavior.
    const presses: number[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: runtime event access
    (endpoint.events as any).switch.initialPress.on(
      (e: { newPosition: number }) => presses.push(e.newPosition),
    );
    const states: HomeAssistantStates = {
      [ENTITY]: state("2026-01-01T00:00:01", "pressed"),
    };
    await endpoint.updateStates(states);
    await delay(200);

    expect(presses).toEqual([1]);
    const actions = firedEvents.filter((e) => e.type === "hamh_action");
    expect(actions).toHaveLength(1);
    expect(actions[0].data).toMatchObject({
      action: "press",
      event_type: "pressed",
      entity_id: ENTITY,
    });
  });

  it("keeps the generic switch default without an override", async () => {
    const type = createLegacyEndpointType({
      entity_id: ENTITY,
      registry: registryEntity(ENTITY),
      state: state("2026-01-01T00:00:00", null),
    });
    expect(type).toBeDefined();
    expect(type!.deviceType).toBe(GENERIC_SWITCH);
  });
});
