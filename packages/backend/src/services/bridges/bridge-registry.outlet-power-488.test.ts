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

const deviceId = "strip-1";

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    device_id: deviceId,
    entity_id: entityId,
    id: entityId,
    unique_id: entityId,
    platform: "test",
    labels: [],
    categories: {},
  } as unknown as HomeAssistantEntityRegistry;
}

function state(
  entityId: string,
  deviceClass: SensorDeviceClass,
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: "0",
    attributes: { device_class: deviceClass },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  } as HomeAssistantEntityState;
}

function sut(states: Record<string, HomeAssistantEntityState>) {
  const entities = Object.fromEntries(
    Object.keys(states).map((id) => [id, registryEntity(id)]),
  );
  const registry = {
    areas: new Map(),
    devices: {
      [deviceId]: { id: deviceId, name: "Strip", labels: [] },
    } as unknown as Record<string, HomeAssistantDeviceRegistry>,
    entities,
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  const dataProvider = {
    featureFlags: { autoBatteryMapping: true },
    filter: { include: [], exclude: [], includeMode: "any" },
  } as unknown as BridgeDataProvider;
  return new BridgeRegistry(registry, dataProvider);
}

describe("BridgeRegistry multi-outlet power/energy mapping (#488)", () => {
  const states: Record<string, HomeAssistantEntityState> = {};
  for (let i = 1; i <= 4; i++) {
    states[`sensor.strip_power_${i}`] = state(
      `sensor.strip_power_${i}`,
      SensorDeviceClass.power,
    );
    states[`sensor.strip_energy_${i}`] = state(
      `sensor.strip_energy_${i}`,
      SensorDeviceClass.energy,
    );
  }

  it("pairs each outlet's power sensor by trailing index", () => {
    const registry = sut(states);
    for (let i = 1; i <= 4; i++) {
      expect(
        registry.findPowerEntityForDevice(deviceId, `switch.strip_switch_${i}`),
      ).toBe(`sensor.strip_power_${i}`);
    }
  });

  it("pairs each outlet's energy sensor by trailing index", () => {
    const registry = sut(states);
    expect(
      registry.findEnergyEntityForDevice(deviceId, "switch.strip_switch_3"),
    ).toBe("sensor.strip_energy_3");
  });

  it("returns the single sensor unchanged for a one-outlet device", () => {
    const registry = sut({
      "sensor.plug_power": state("sensor.plug_power", SensorDeviceClass.power),
    });
    expect(registry.findPowerEntityForDevice(deviceId, "switch.plug")).toBe(
      "sensor.plug_power",
    );
  });

  it("falls back to the first match when the requester has no index", () => {
    const registry = sut(states);
    expect(registry.findPowerEntityForDevice(deviceId, "switch.strip")).toBe(
      "sensor.strip_power_1",
    );
  });
});
