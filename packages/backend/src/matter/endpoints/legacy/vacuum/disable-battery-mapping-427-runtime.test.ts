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
import { ServerModeVacuumEndpoint } from "../../server-mode-vacuum-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #427 runtime layer for vacuums. The vacuum always gets a PowerSource, and the
// battery reader falls back to the vacuum's own battery_level attribute. The
// construction-time strip cleans init, but a live update restores the attribute
// unless the reader honors disableBatteryMapping on every read.

const DEVICE = "vac-dev";
const VACUUM = "vacuum.robot";
const BATTERY = "sensor.robot_battery";

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

function vacuumState(batteryLevel: number): HomeAssistantEntityState {
  return state(VACUUM, "docked", {
    supported_features: 15,
    fan_speed: "medium",
    fan_speed_list: ["off", "low", "medium", "high"],
    battery_level: batteryLevel,
  });
}

// Registry with only the vacuum (own battery_level attribute, no separate
// battery sensor) so the reader falls back to the attribute.
function registry(batteryLevel: number): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [VACUUM]: vacuumState(batteryLevel),
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

// Registry with the vacuum plus a same-device battery sensor, for the
// server-mode manual mapping case.
function registryWithBattery(): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [VACUUM]: vacuumState(75),
    [BATTERY]: state(BATTERY, "60", { device_class: "battery" }),
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-427vac-"));
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
    getBatteryPercent: (id: string) => (id === BATTERY ? 60 : null),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(
  reg: BridgeRegistry,
  mapping?: EntityMappingConfig,
): Promise<LegacyEndpoint> {
  const endpoint = await LegacyEndpoint.create(reg, VACUUM, mapping);
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `427vac-node-${counter++}`,
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

async function deliver(endpoint: LegacyEndpoint, batteryLevel: number) {
  const states: HomeAssistantStates = { [VACUUM]: vacuumState(batteryLevel) };
  await endpoint.updateStates(states);
  await delay(200);
}

function batPercent(endpoint: LegacyEndpoint): number | null | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state off endpoint
  return (endpoint.state as any).powerSource?.batPercentRemaining;
}

describe("disableBatteryMapping vacuum runtime (#427)", () => {
  it("reports no battery at init and after an update, with the flag", async () => {
    const mapping: EntityMappingConfig = {
      entityId: VACUUM,
      disableBatteryMapping: true,
    };
    const endpoint = await mount(registry(75), mapping);
    // Init: construction strips battery_level, so batPercentRemaining is null.
    expect(batPercent(endpoint) ?? null).toBeNull();

    // A live update restores battery_level=75 unless the reader honors the
    // flag. Red-before yields 150 (75 * 2) here.
    await deliver(endpoint, 75);
    expect(batPercent(endpoint) ?? null).toBeNull();
  });

  it("reports battery normally without the flag (guard)", async () => {
    const endpoint = await mount(registry(75));
    // batPercentRemaining is in half-percent units (75 * 2).
    expect(batPercent(endpoint)).toBe(150);

    await deliver(endpoint, 40);
    expect(batPercent(endpoint)).toBe(80);
  });

  it("server mode drops a manual batteryEntity with the flag", async () => {
    const reg = registryWithBattery();
    const mapping: EntityMappingConfig = {
      entityId: VACUUM,
      batteryEntity: BATTERY,
      disableBatteryMapping: true,
    };
    const endpoint = await ServerModeVacuumEndpoint.create(
      reg,
      VACUUM,
      mapping,
    );
    expect(endpoint).toBeDefined();
    // Red-before: the manual batteryEntity survives and gets subscribed.
    expect(endpoint!.mappedEntityIds).not.toContain(BATTERY);
  });

  it("server mode keeps a manual batteryEntity without the flag (guard)", async () => {
    const reg = registryWithBattery();
    const mapping: EntityMappingConfig = {
      entityId: VACUUM,
      batteryEntity: BATTERY,
    };
    const endpoint = await ServerModeVacuumEndpoint.create(
      reg,
      VACUUM,
      mapping,
    );
    expect(endpoint).toBeDefined();
    expect(endpoint!.mappedEntityIds).toContain(BATTERY);
  });
});
