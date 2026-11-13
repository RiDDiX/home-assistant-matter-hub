import {
  type HomeAssistantDeviceRegistry,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { HomeAssistantRegistry } from "../home-assistant/home-assistant-registry.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeRegistry } from "./bridge-registry.js";

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
  autoBatteryMapping = true,
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
    featureFlags: { autoBatteryMapping },
    filter: { include: [], exclude: [], includeMode: "any" },
  } as unknown as BridgeDataProvider;

  return new BridgeRegistry(registry, dataProvider);
}

describe("BridgeRegistry battery mapping", () => {
  it("skips numeric battery sensors whose current state is not resolvable", () => {
    const registry = sut({
      "sensor.battery_level": state("sensor.battery_level", "Unknown", {
        device_class: SensorDeviceClass.battery,
      }),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBeUndefined();
  });

  it("uses a same-device enum battery sensor when no numeric value is available", () => {
    const registry = sut({
      "sensor.battery_level": state("sensor.battery_level", "Unknown", {
        device_class: SensorDeviceClass.battery,
      }),
      "sensor.battery": state("sensor.battery", "full", {
        device_class: "enum",
      }),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.battery",
    );
  });

  it("keeps valid numeric battery sensors preferred over enum fallback", () => {
    const registry = sut({
      "sensor.battery_level": state("sensor.battery_level", "74", {
        device_class: SensorDeviceClass.battery,
      }),
      "sensor.battery": state("sensor.battery", "full", {
        device_class: "enum",
      }),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.battery_level",
    );
  });

  it("keeps binary battery fallback", () => {
    const registry = sut({
      "binary_sensor.low_battery": state("binary_sensor.low_battery", "off", {
        device_class: "battery",
      }),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "binary_sensor.low_battery",
    );
  });

  it("does not map a classless numeric sensor like last_clean_area", () => {
    const registry = sut({
      "sensor.last_clean_area": state("sensor.last_clean_area", "27", {}),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBeUndefined();
  });

  it("maps a classless percentage battery sensor (e.g. Roborock)", () => {
    const registry = sut({
      "sensor.roborock_battery": state("sensor.roborock_battery", "85", {
        unit_of_measurement: "%",
      }),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.roborock_battery",
    );
  });

  it("maps a classless battery-named enum sensor", () => {
    const registry = sut({
      "sensor.door_battery": state("sensor.door_battery", "normal", {}),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.door_battery",
    );
  });

  it("resolves the sensor after a refresh once it has a state (#450)", () => {
    const states: Record<string, HomeAssistantEntityState> = {
      "sensor.robot_battery": state("sensor.robot_battery", "85", {
        device_class: SensorDeviceClass.battery,
      }),
    };
    const registry = sut(states);
    // registry entry without a state yet, an unavailable one counts (#543)
    delete states["sensor.robot_battery"];
    expect(registry.findBatteryEntityForDevice(deviceId)).toBeUndefined();
    // negative answer is cached until the next refresh
    expect(registry.findBatteryEntityForDevice(deviceId)).toBeUndefined();

    states["sensor.robot_battery"] = state("sensor.robot_battery", "85", {
      device_class: SensorDeviceClass.battery,
    });
    registry.refresh();
    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.robot_battery",
    );
  });

  it.each([
    "unavailable",
    "unknown",
  ])("maps a %s battery sensor so the device shape does not wait for a value (#543)", (value) => {
    const registry = sut({
      "sensor.robot_battery": state("sensor.robot_battery", value, {
        device_class: SensorDeviceClass.battery,
      }),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.robot_battery",
    );
  });

  it("prefers a live battery sensor over an unavailable one (#543)", () => {
    const registry = sut({
      "sensor.a_battery": state("sensor.a_battery", "unavailable", {
        device_class: SensorDeviceClass.battery,
      }),
      "sensor.b_battery": state("sensor.b_battery", "74", {
        device_class: SensorDeviceClass.battery,
      }),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.b_battery",
    );
  });

  it("does not map an unavailable sensor without the battery class (#461, #543)", () => {
    const registry = sut({
      "sensor.robot_battery": state("sensor.robot_battery", "unavailable", {}),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBeUndefined();
  });

  it("prefers a real battery sensor over a classless last_clean_area sibling", () => {
    const registry = sut({
      "sensor.last_clean_area": state("sensor.last_clean_area", "27", {}),
      "sensor.battery_level": state("sensor.battery_level", "74", {
        device_class: SensorDeviceClass.battery,
      }),
    });

    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.battery_level",
    );
  });
});

describe("batteryFingerprintFor (#450)", () => {
  const VACUUM = "vacuum.robot";
  const BATTERY = "sensor.robot_battery";

  function vacuumStates(
    batteryValue: string,
  ): Record<string, HomeAssistantEntityState> {
    return {
      [VACUUM]: state(VACUUM, "docked", {}),
      [BATTERY]: state(BATTERY, batteryValue, {
        device_class: SensorDeviceClass.battery,
      }),
    };
  }

  it("follows the resolver across a refresh", () => {
    const states = vacuumStates("85");
    const registry = sut(states);
    // registry entry without a state yet, an unavailable one counts (#543)
    delete states[BATTERY];
    registry.refresh();
    expect(registry.batteryFingerprintFor(VACUUM, undefined)).toBe("");

    states[BATTERY] = state(BATTERY, "85", {
      device_class: SensorDeviceClass.battery,
    });
    registry.refresh();
    expect(registry.batteryFingerprintFor(VACUUM, undefined)).toBe(BATTERY);
  });

  it("is the same for an unavailable battery and its later value, no rebuild (#543)", () => {
    const states = vacuumStates("unavailable");
    const registry = sut(states);
    const before = registry.batteryFingerprintFor(VACUUM, undefined);
    expect(before).toBe(BATTERY);

    states[BATTERY] = state(BATTERY, "85", {
      device_class: SensorDeviceClass.battery,
    });
    registry.refresh();
    expect(registry.batteryFingerprintFor(VACUUM, undefined)).toBe(before);
  });

  it("stays empty when the mapping already decides the battery", () => {
    const registry = sut(vacuumStates("85"));
    expect(
      registry.batteryFingerprintFor(VACUUM, {
        entityId: VACUUM,
        batteryEntity: BATTERY,
      }),
    ).toBe("");
    expect(
      registry.batteryFingerprintFor(VACUUM, {
        entityId: VACUUM,
        disableBatteryMapping: true,
      }),
    ).toBe("");
  });

  it("vacuums resolve even without the auto mapping flag, others do not", () => {
    const registry = sut(vacuumStates("85"), false);
    expect(registry.batteryFingerprintFor(VACUUM, undefined)).toBe(BATTERY);
    expect(registry.batteryFingerprintFor(BATTERY, undefined)).toBe("");
  });

  it("sensor endpoints resolve the device battery like the build does (#498)", () => {
    const states = vacuumStates("85");
    states["sensor.robot_temp"] = state("sensor.robot_temp", "21", {});
    states["binary_sensor.robot_door"] = state(
      "binary_sensor.robot_door",
      "off",
      {},
    );
    const registry = sut(states, true);
    expect(registry.batteryFingerprintFor("sensor.robot_temp", undefined)).toBe(
      BATTERY,
    );
    expect(registry.batteryFingerprintFor(BATTERY, undefined)).toBe("");
    expect(
      registry.batteryFingerprintFor("binary_sensor.robot_door", undefined),
    ).toBe("");
  });
});

describe("BridgeRegistry charging entity lookup (#450)", () => {
  it("takes the battery_charging binary sensor on the same device", () => {
    const registry = sut({
      "binary_sensor.robot_charging": state(
        "binary_sensor.robot_charging",
        "off",
        { device_class: "battery_charging" },
      ),
    });

    expect(registry.findChargingEntityForDevice(deviceId)).toBe(
      "binary_sensor.robot_charging",
    );
  });

  it("falls back to a charging_state sensor", () => {
    const registry = sut({
      "sensor.robot_charging_state": state(
        "sensor.robot_charging_state",
        "not_charging",
        {},
      ),
    });

    expect(registry.findChargingEntityForDevice(deviceId)).toBe(
      "sensor.robot_charging_state",
    );
  });

  it("prefers the binary sensor over the state sensor", () => {
    const registry = sut({
      "sensor.robot_charging_state": state(
        "sensor.robot_charging_state",
        "charging",
        {},
      ),
      "binary_sensor.robot_charging": state(
        "binary_sensor.robot_charging",
        "on",
        { device_class: "battery_charging" },
      ),
    });

    expect(registry.findChargingEntityForDevice(deviceId)).toBe(
      "binary_sensor.robot_charging",
    );
  });

  it("ignores unrelated sensors", () => {
    const registry = sut({
      "binary_sensor.robot_problem": state(
        "binary_sensor.robot_problem",
        "off",
        { device_class: "problem" },
      ),
      "sensor.robot_charging_power": state(
        "sensor.robot_charging_power",
        "12",
        {},
      ),
    });

    expect(registry.findChargingEntityForDevice(deviceId)).toBeUndefined();
  });
});

describe("BridgeRegistry per-device lookup", () => {
  it("matches a full registry scan and follows a reloaded entity map", () => {
    const states: Record<string, HomeAssistantEntityState> = {
      "sensor.a_battery": state("sensor.a_battery", "80", {
        device_class: "battery",
      }),
      "binary_sensor.a_problem": state("binary_sensor.a_problem", "off", {
        device_class: "problem",
      }),
      "sensor.b_battery": state("sensor.b_battery", "50", {
        device_class: "battery",
      }),
    };
    const entities: Record<string, HomeAssistantEntityRegistry> = {
      "sensor.a_battery": registryEntity("sensor.a_battery"),
      "binary_sensor.a_problem": registryEntity("binary_sensor.a_problem"),
      "sensor.b_battery": {
        ...registryEntity("sensor.b_battery"),
        device_id: "device-2",
      },
    };
    const ha = {
      areas: new Map(),
      devices: { [deviceId]: device() },
      entities,
      labels: [],
      states,
    };
    const registry = new BridgeRegistry(
      ha as unknown as HomeAssistantRegistry,
      {
        featureFlags: { autoBatteryMapping: true },
        filter: { include: [], exclude: [], includeMode: "any" },
      } as unknown as BridgeDataProvider,
    );
    const lookup = (id: string) =>
      (
        registry as unknown as {
          entitiesOfDevice(id: string): HomeAssistantEntityRegistry[];
        }
      ).entitiesOfDevice(id);
    const scan = (id: string) =>
      Object.values(ha.entities).filter((e) => e.device_id === id);

    expect(lookup(deviceId)).toHaveLength(2);
    expect(lookup(deviceId)).toEqual(scan(deviceId));
    expect(lookup("device-2")).toEqual(scan("device-2"));
    expect(registry.findBatteryEntityForDevice(deviceId)).toBe(
      "sensor.a_battery",
    );

    // an HA reload swaps the map, no bridge refresh in between
    ha.entities = {
      ...entities,
      "sensor.a_charging_state": registryEntity("sensor.a_charging_state"),
    };
    states["sensor.a_charging_state"] = state(
      "sensor.a_charging_state",
      "charging",
      {},
    );
    expect(lookup(deviceId)).toEqual(scan(deviceId));
    expect(registry.findChargingEntityForDevice(deviceId)).toBe(
      "sensor.a_charging_state",
    );
  });
});
