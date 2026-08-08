import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, Logger, VariableService } from "@matter/general";
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
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #428 regression guard: VacuumOnOffServer.isOn used to request the deprecated
// VacuumRvcRunModeServer class while the endpoint installs a per-entity
// generated sibling, so every onOff.update reactor tick threw
// "installed implementation is incompatible". isOn now resolves through the
// matter base RvcRunModeServer, which every installed variant extends.

const DEVICE = "vac-dev";
const VACUUM = "vacuum.robot";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

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

// vacuumOnOff feature flag enabled -> VacuumOnOffServer is installed.
function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: { vacuumOnOff: true },
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

function vacuumState(value: string): HomeAssistantEntityState {
  return state(VACUUM, value, {
    supported_features: 15,
    fan_speed: "medium",
    fan_speed_list: ["off", "low", "medium", "high"],
    battery_level: 75,
  });
}

function registry(value: string): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [VACUUM]: vacuumState(value),
  };
  const entities = Object.fromEntries(
    Object.keys(states).map((id) => [id, registryEntity(id)]),
  );
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Robot" } },
    entities,
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

// Capture matter.js log output so we can detect the post-commit transaction
// error raised inside the onOff.update reactor.
let captured: string[] = [];
let restoreWrite: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-428vac-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);

  captured = [];
  const dest = Logger.destinations.default;
  const orig = dest.write;
  dest.write = (text: string, message: unknown) => {
    captured.push(text);
    orig?.(text, message as never);
  };
  restoreWrite = () => {
    dest.write = orig;
  };
});

afterEach(async () => {
  restoreWrite?.();
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(value: string): Promise<LegacyEndpoint> {
  const endpoint = await LegacyEndpoint.create(registry(value), VACUUM);
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `428vac-node-${counter++}`,
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

async function deliver(endpoint: LegacyEndpoint, value: string) {
  const states: HomeAssistantStates = { [VACUUM]: vacuumState(value) };
  await endpoint.updateStates(states);
  await delay(200);
}

describe("vacuum onOff run mode resolution (#428)", () => {
  it("state changes drive onOff cleanly, no reactor error", async () => {
    const endpoint = await mount("docked");
    captured = [];
    await deliver(endpoint, "cleaning");
    const hit = captured.filter((t) =>
      t.includes("installed implementation is incompatible"),
    );
    expect(hit).toEqual([]);
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).onOff.onOff).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).rvcRunMode.currentMode).toBe(1);

    await deliver(endpoint, "docked");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).onOff.onOff).toBe(false);
  });
});
