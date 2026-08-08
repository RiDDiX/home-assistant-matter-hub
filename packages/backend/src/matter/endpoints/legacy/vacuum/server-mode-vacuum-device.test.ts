import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { validateEndpointType } from "../../validate-endpoint-type.js";
import { ServerModeVacuumDevice } from "./server-mode-vacuum-device.js";

function createVacuumEntity(
  entityId: string,
  attributes: Partial<VacuumDeviceAttributes> = {},
): HomeAssistantEntityBehavior.State {
  const registry: HomeAssistantEntityRegistry = {
    device_id: `${entityId}_device`,
    categories: {},
    entity_id: entityId,
    has_entity_name: false,
    id: entityId,
    original_name: entityId,
    platform: "test",
    unique_id: entityId,
  };
  const state: HomeAssistantEntityState = {
    entity_id: entityId,
    state: "docked",
    context: { id: "context" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
    attributes: {
      supported_features: 15,
      battery_level: 75,
      fan_speed: "medium",
      fan_speed_list: ["off", "low", "medium", "high"],
      ...attributes,
    },
  };
  const entity: HomeAssistantEntityInformation = {
    entity_id: entityId,
    registry,
    state,
  };
  return { entity };
}

describe("ServerModeVacuumDevice", () => {
  it("creates a valid endpoint type for a basic vacuum", () => {
    const ha = createVacuumEntity("vacuum.roborock");
    const type = ServerModeVacuumDevice(ha);

    expect(type).toBeDefined();
    const result = validateEndpointType(type!, "vacuum.roborock");
    expect(result).toBeDefined();
    expect(result!.missingMandatory).toEqual([]);
    expect(result!.deviceTypeName).toBe("RoboticVacuumCleaner");
  });

  it("does NOT include BasicInformation (standalone device)", () => {
    const ha = createVacuumEntity("vacuum.server_vac");
    const type = ServerModeVacuumDevice(ha);

    expect(type).toBeDefined();
    expect(type!.behaviors).not.toHaveProperty("bridgedDeviceBasicInformation");
  });

  it("returns undefined when entity state is undefined", () => {
    const ha = createVacuumEntity("vacuum.no_state");
    ha.entity.state = undefined as unknown as HomeAssistantEntityState;
    const type = ServerModeVacuumDevice(ha);
    expect(type).toBeUndefined();
  });

  it("includes OnOff cluster when explicitly enabled", () => {
    const ha = createVacuumEntity("vacuum.with_onoff");
    const type = ServerModeVacuumDevice(ha, true);

    expect(type).toBeDefined();
    expect(type!.behaviors).toHaveProperty("onOff");
  });

  it("excludes OnOff cluster by default", () => {
    const ha = createVacuumEntity("vacuum.no_onoff");
    const type = ServerModeVacuumDevice(ha, false);

    expect(type).toBeDefined();
    expect(type!.behaviors).not.toHaveProperty("onOff");
  });

  it("includes RvcCleanMode with cleaning mode options", () => {
    const ha = createVacuumEntity("vacuum.with_clean_modes");
    const type = ServerModeVacuumDevice(ha, false, [
      "vacuum",
      "mop",
      "vacuum_and_mop",
    ]);

    expect(type).toBeDefined();
    expect(type!.behaviors).toHaveProperty("rvcCleanMode");
  });

  it("includes PowerSource for battery info", () => {
    const ha = createVacuumEntity("vacuum.with_battery", {
      battery_level: 80,
    });
    const type = ServerModeVacuumDevice(ha);

    expect(type).toBeDefined();
    expect(type!.behaviors).toHaveProperty("powerSource");
  });

  it("includes ServiceArea with default single area when no rooms", () => {
    const ha = createVacuumEntity("vacuum.no_rooms", {
      supported_features: 15,
    });
    const type = ServerModeVacuumDevice(ha);

    expect(type).toBeDefined();
    expect(type!.behaviors).toHaveProperty("serviceArea");
  });

  it("includes ServiceArea with rooms when rooms attribute is present", () => {
    const ha = createVacuumEntity("vacuum.with_rooms", {
      supported_features: 15,
      rooms: { "1": "Kitchen", "2": "Living Room" },
    });
    const type = ServerModeVacuumDevice(ha);

    expect(type).toBeDefined();
    expect(type!.behaviors).toHaveProperty("serviceArea");
  });
});
