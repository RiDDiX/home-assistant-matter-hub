import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
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
import { ServerModeVacuumEndpoint } from "../../server-mode-vacuum-endpoint.js";

// #450: the percentage is a quieter attribute, matter.js reported it ten
// seconds after the write. It goes out with the write now.

const DEVICE = "vac-dev";
const VACUUM = "vacuum.robot";
const BATTERY = "sensor.robot_battery";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
// the live HA state map, mutated like mergeExternalStates does
let liveStates: HomeAssistantStates;

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
    last_updated: "2026-01-01T00:00:00",
  };
}

function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: { autoBatteryMapping: true },
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

// The reported setup: HA moved the battery OUT of the vacuum entity, so the
// vacuum carries no battery_level, only the separate battery sensor has it.
function vacuumState(): HomeAssistantEntityState {
  return state(VACUUM, "docked", {
    supported_features: 15,
    fan_speed: "medium",
    fan_speed_list: ["off", "low", "medium", "high"],
  });
}

function batteryState(percent: number): HomeAssistantEntityState {
  return state(BATTERY, String(percent), { device_class: "battery" });
}

function makeRegistry(): BridgeRegistry {
  liveStates = {
    [VACUUM]: vacuumState(),
    [BATTERY]: batteryState(96),
  };
  const entities = Object.fromEntries(
    Object.keys(liveStates).map((id) => [id, registryEntity(id)]),
  );
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Robot" } },
    entities,
    labels: [],
    // same object reference, so a mutation is a live HA state change
    states: liveStates,
  } as unknown as HomeAssistantRegistry;
  // real provider, reading live registry states
  env.set(EntityStateProvider, new EntityStateProvider(haRegistry));
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-450probe-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newServer(): Promise<ServerNode> {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `450probe-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  return server;
}

// biome-ignore lint/suspicious/noExplicitAny: read cluster state off endpoint
function batPercent(endpoint: any): number | null | undefined {
  return endpoint.state.powerSource?.batPercentRemaining;
}

// a battery-sensor-only change, exactly what HA emits: a new state object for
// the sensor, the same values for the vacuum
async function deliverBatteryOnly(
  // biome-ignore lint/suspicious/noExplicitAny: both endpoint classes
  endpoint: any,
  percent: number,
) {
  liveStates[BATTERY] = batteryState(percent);
  // fresh vacuum state object with identical content, like the HA diff copy
  liveStates[VACUUM] = vacuumState();
  await endpoint.updateStates({ ...liveStates });
  await delay(300);
}

const POWER_SOURCE = 47;
const BAT_PERCENT_REMAINING = 12;

describe("battery percent reporting (#450)", () => {
  it("reports batPercentRemaining together with the write", async () => {
    const reg = makeRegistry();
    const endpoint = await ServerModeVacuumEndpoint.create(reg, VACUUM);
    expect(endpoint).toBeDefined();
    const node = await newServer();
    await node.add(endpoint!);
    await delay(300);

    const reported: number[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: subscription change stream
    (node as any).protocol.attrsChanged.on(
      (_ep: number, cluster: number, attrs: number[]) => {
        if (Number(cluster) === POWER_SOURCE) {
          reported.push(...attrs.map(Number));
        }
      },
    );

    // Still inside the quiet window of the initial value.
    await deliverBatteryOnly(endpoint!, 90);
    await delay(500);
    expect(batPercent(endpoint)).toBe(180);
    expect(reported).toContain(BAT_PERCENT_REMAINING);
  });
});
