import {
  BinarySensorDeviceClass,
  type EntityMappingConfig,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import type { HomeAssistantRegistry } from "../../../../services/home-assistant/home-assistant-registry.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// Xiaomi Home (and others) report a bogus battery sensor on mains-powered
// devices. The auto battery mapper attaches it (or the entity's own
// battery/battery_level attribute) as a PowerSource, and controllers show a
// false low-battery warning. disableBatteryMapping opts a single entity out
// of both attach paths.

const DEVICE = "device-427";
const SENSOR = "binary_sensor.door";
const BATTERY = "sensor.door_battery";

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

function registry(opts: {
  battery?: boolean;
  batteryLevelAttr?: number;
}): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [SENSOR]: state(SENSOR, "off", {
      device_class: BinarySensorDeviceClass.Door,
      ...(opts.batteryLevelAttr != null
        ? { battery_level: opts.batteryLevelAttr }
        : {}),
    }),
  };
  if (opts.battery) {
    states[BATTERY] = state(BATTERY, "50", { device_class: "battery" });
  }
  const entities = Object.fromEntries(
    Object.keys(states).map((id) => [id, registryEntity(id)]),
  );
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Door" } },
    entities,
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  const dataProvider = {
    featureFlags: { autoBatteryMapping: true },
    filter: { include: [], exclude: [], includeMode: "any" },
  } as unknown as BridgeDataProvider;
  return new BridgeRegistry(haRegistry, dataProvider);
}

function behaviors(endpoint: LegacyEndpoint): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: read the endpoint type off the instance
  return (endpoint as any).type.behaviors;
}

describe("disableBatteryMapping (#427)", () => {
  it("suppresses an auto-mapped same-device battery sensor", async () => {
    const reg = registry({ battery: true });
    const mapping: EntityMappingConfig = {
      entityId: SENSOR,
      disableBatteryMapping: true,
    };
    const endpoint = await LegacyEndpoint.create(reg, SENSOR, mapping);
    expect(endpoint).toBeDefined();
    expect(behaviors(endpoint!)).not.toHaveProperty("powerSource");
    expect(endpoint!.mappedEntityIds).not.toContain(BATTERY);
  });

  it("auto-maps the same-device battery sensor without the flag (guard)", async () => {
    const reg = registry({ battery: true });
    const endpoint = await LegacyEndpoint.create(reg, SENSOR);
    expect(endpoint).toBeDefined();
    expect(behaviors(endpoint!)).toHaveProperty("powerSource");
    expect(endpoint!.mappedEntityIds).toContain(BATTERY);
  });

  it("suppresses a WithBattery variant from the entity's own battery_level attribute", async () => {
    const reg = registry({ batteryLevelAttr: 42 });
    const mapping: EntityMappingConfig = {
      entityId: SENSOR,
      disableBatteryMapping: true,
    };
    const endpoint = await LegacyEndpoint.create(reg, SENSOR, mapping);
    expect(endpoint).toBeDefined();
    expect(behaviors(endpoint!)).not.toHaveProperty("powerSource");
  });
});
