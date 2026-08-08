import {
  type EntityMappingConfig,
  type HomeAssistantDeviceRegistry,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import type { HomeAssistantRegistry } from "../../../services/home-assistant/home-assistant-registry.js";
import { LegacyEndpoint } from "./legacy-endpoint.js";

// An outlet, its indicator light and the device's power/energy sensors all
// share one HA device. The auto-mapping must hand the sensors to the outlet
// (switch) but never to the indicator light, otherwise the light endpoint gets
// electrical clusters that Aqara Home rejects (#374).

const deviceId = "device-1";

function device(): HomeAssistantDeviceRegistry {
  return {
    id: deviceId,
    identifiers: [],
    name: "Outlet",
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

function sut(): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    "switch.outlet": state("switch.outlet", "on"),
    "light.indicator": state("light.indicator", "on"),
    "sensor.outlet_power": state("sensor.outlet_power", "1500", {
      device_class: SensorDeviceClass.power,
    }),
    "sensor.outlet_energy": state("sensor.outlet_energy", "12.5", {
      device_class: SensorDeviceClass.energy,
    }),
  };
  const entities = Object.fromEntries(
    Object.keys(states).map((id) => [id, registryEntity(id)]),
  );
  const registry = {
    areas: new Map(),
    devices: { [deviceId]: device() },
    entities,
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  const dataProvider = {
    featureFlags: {},
    filter: { include: [], exclude: [], includeMode: "any" },
  } as unknown as BridgeDataProvider;
  return new BridgeRegistry(registry, dataProvider);
}

async function mappedIds(
  entityId: string,
  mapping?: EntityMappingConfig,
): Promise<string[]> {
  const endpoint = await LegacyEndpoint.create(sut(), entityId, mapping);
  expect(endpoint).toBeDefined();
  return endpoint?.mappedEntityIds ?? [];
}

describe("power/energy auto-mapping (#374)", () => {
  it("auto-maps the device power/energy sensors onto the outlet", async () => {
    const ids = await mappedIds("switch.outlet");
    expect(ids).toContain("sensor.outlet_power");
    expect(ids).toContain("sensor.outlet_energy");
  });

  it("does not auto-map them onto the indicator light", async () => {
    const ids = await mappedIds("light.indicator");
    expect(ids).not.toContain("sensor.outlet_power");
    expect(ids).not.toContain("sensor.outlet_energy");
  });

  it("still honors a power sensor set explicitly on a light", async () => {
    const ids = await mappedIds("light.indicator", {
      entityId: "light.indicator",
      powerEntity: "sensor.outlet_power",
    });
    expect(ids).toContain("sensor.outlet_power");
  });
});
