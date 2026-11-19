import {
  type EntityMappingConfig,
  type HomeAssistantDeviceRegistry,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { HomeAssistantRegistry } from "../home-assistant/home-assistant-registry.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { FilterTimeoutError } from "./matcher/matches-entity-filter.js";

const deviceId = "device-1";

function device(): HomeAssistantDeviceRegistry {
  return {
    id: deviceId,
    identifiers: [],
    name: "Device",
    labels: [],
  } as unknown as HomeAssistantDeviceRegistry;
}

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    area_id: null,
    categories: {},
    device_id: deviceId,
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
  attributes: Record<string, unknown>,
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

function sut(
  states: Record<string, HomeAssistantEntityState>,
  featureFlags: Record<string, boolean> = {},
) {
  const entities = Object.fromEntries(
    Object.keys(states).map((entityId) => [entityId, registryEntity(entityId)]),
  );
  const registry = {
    areas: new Map(),
    devices: { [deviceId]: device() },
    entities,
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  const dataProvider = {
    name: "Test",
    featureFlags,
    filter: { include: [], exclude: [], includeMode: "any" },
  } as unknown as BridgeDataProvider;

  return new BridgeRegistry(registry, dataProvider);
}

const sensors = (...extra: string[]) => ({
  ...Object.fromEntries(
    ["sensor.temperature", ...extra].map((id) => [
      id,
      state(id, "21", { device_class: SensorDeviceClass.temperature }),
    ]),
  ),
  "sensor.humidity": state("sensor.humidity", "40", {
    device_class: SensorDeviceClass.humidity,
  }),
  "sensor.pressure": state("sensor.pressure", "1013", {
    device_class: SensorDeviceClass.pressure,
  }),
});

function refreshWith(
  registry: BridgeRegistry,
  mappings: Record<string, Partial<EntityMappingConfig>>,
) {
  registry.refresh(
    (entityId) => mappings[entityId] && { entityId, ...mappings[entityId] },
  );
}

describe("BridgeRegistry humidity and pressure pre-calculation", () => {
  it("claims both for the temperature sensor by default", () => {
    const registry = sut(sensors());
    refreshWith(registry, {});
    expect(registry.isHumidityEntityUsed("sensor.humidity")).toBe(true);
    expect(registry.isPressureEntityUsed("sensor.pressure")).toBe(true);
  });

  it("claims nothing for a disabled temperature sensor", () => {
    const registry = sut(sensors());
    refreshWith(registry, { "sensor.temperature": { disabled: true } });
    expect(registry.isHumidityEntityUsed("sensor.humidity")).toBe(false);
    expect(registry.isPressureEntityUsed("sensor.pressure")).toBe(false);
  });

  it("leaves the device sensors standalone when the mapping names others", () => {
    const registry = sut(sensors());
    refreshWith(registry, {
      "sensor.temperature": {
        humidityEntity: "sensor.other_humidity",
        pressureEntity: "sensor.other_pressure",
      },
    });
    expect(registry.isHumidityEntityUsed("sensor.humidity")).toBe(false);
    expect(registry.isPressureEntityUsed("sensor.pressure")).toBe(false);
  });

  it("lets only the first temperature sensor of a device claim", () => {
    const registry = sut(sensors("sensor.temperature_2"));
    refreshWith(registry, {});
    expect(registry.isHumidityEntityUsed("sensor.humidity")).toBe(true);
    expect(
      registry.isHumidityEntityClaimedByOther(
        "sensor.humidity",
        "sensor.temperature",
      ),
    ).toBe(false);
    expect(
      registry.isHumidityEntityClaimedByOther(
        "sensor.humidity",
        "sensor.temperature_2",
      ),
    ).toBe(true);
    expect(
      registry.isPressureEntityClaimedByOther(
        "sensor.pressure",
        "sensor.temperature_2",
      ),
    ).toBe(true);
  });
});

describe("BridgeRegistry battery pre-calculation", () => {
  const door = () => ({
    "binary_sensor.door": state("binary_sensor.door", "off", {
      device_class: "door",
    }),
    "sensor.door_battery": state("sensor.door_battery", "80", {
      device_class: SensorDeviceClass.battery,
    }),
  });
  const auto = { autoBatteryMapping: true };

  it("claims the device battery for the main entity", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, {});
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(true);
  });

  it("claims nothing for a disabled main entity", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, { "binary_sensor.door": { disabled: true } });
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(false);
  });

  it("keeps a battery hidden when the main entity opts out of it", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, {
      "binary_sensor.door": { disableBatteryMapping: true },
    });
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(true);
  });

  it("leaves the device battery standalone when the mapping names another", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, {
      "binary_sensor.door": { batteryEntity: "sensor.other_battery" },
    });
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(false);
  });

  it("still claims the battery the mapping names explicitly", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, {
      "binary_sensor.door": { batteryEntity: "sensor.door_battery" },
    });
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(true);
  });
});

describe("BridgeRegistry filter budget", () => {
  it("throws on a slow pattern and keeps the last entity list", () => {
    const id = `sensor.${"a".repeat(43)}`;
    const registry = sut(sensors(id));
    refreshWith(registry, {});
    const before = registry.entityIds;
    const filter = (
      registry as unknown as {
        dataProvider: { filter: { include: unknown[] } };
      }
    ).dataProvider.filter;
    filter.include = [{ type: "regex", value: "(.*)*x" }];

    const started = Date.now();
    expect(() => refreshWith(registry, {})).toThrow(FilterTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(registry.entityIds).toEqual(before);
    expect(registry.isHumidityEntityUsed("sensor.humidity")).toBe(true);
  });
});
