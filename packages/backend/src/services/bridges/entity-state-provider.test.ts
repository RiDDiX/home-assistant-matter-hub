import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../home-assistant/home-assistant-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";

function entity(entityId: string, state: string): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state,
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
    attributes: {},
  };
}

function provider(states: HomeAssistantStates) {
  return new EntityStateProvider({ states } as HomeAssistantRegistry);
}

describe("EntityStateProvider.getBatteryPercent", () => {
  it("keeps numeric battery states unchanged", () => {
    const sut = provider({
      "sensor.battery": entity("sensor.battery", "42.5"),
    });

    expect(sut.getBatteryPercent("sensor.battery")).toBe(42.5);
  });

  it("keeps binary battery states unchanged", () => {
    const sut = provider({
      "binary_sensor.battery_ok": entity("binary_sensor.battery_ok", "off"),
      "binary_sensor.battery_low": entity("binary_sensor.battery_low", "on"),
    });

    expect(sut.getBatteryPercent("binary_sensor.battery_ok")).toBe(100);
    expect(sut.getBatteryPercent("binary_sensor.battery_low")).toBe(0);
  });

  it("maps known enum battery states to percentages", () => {
    const sut = provider({
      "sensor.battery_full": entity("sensor.battery_full", "full"),
      "sensor.battery_high": entity("sensor.battery_high", "high"),
      "sensor.battery_normal": entity("sensor.battery_normal", "normal"),
      "sensor.battery_medium": entity("sensor.battery_medium", "medium"),
      "sensor.battery_low": entity("sensor.battery_low", "low"),
      "sensor.battery_verylow": entity("sensor.battery_verylow", "verylow"),
      "sensor.battery_empty": entity("sensor.battery_empty", "empty"),
    });

    expect(sut.getBatteryPercent("sensor.battery_full")).toBe(100);
    expect(sut.getBatteryPercent("sensor.battery_high")).toBe(90);
    expect(sut.getBatteryPercent("sensor.battery_normal")).toBe(70);
    expect(sut.getBatteryPercent("sensor.battery_medium")).toBe(50);
    expect(sut.getBatteryPercent("sensor.battery_low")).toBe(20);
    expect(sut.getBatteryPercent("sensor.battery_verylow")).toBe(5);
    expect(sut.getBatteryPercent("sensor.battery_empty")).toBe(0);
  });

  it("treats enum states case-insensitively", () => {
    const sut = provider({
      "sensor.battery": entity("sensor.battery", "VeryLow"),
    });

    expect(sut.getBatteryPercent("sensor.battery")).toBe(5);
  });

  it("returns null for unknown battery states", () => {
    const sut = provider({
      "sensor.battery": entity("sensor.battery", "Unknown"),
    });

    expect(sut.getBatteryPercent("sensor.battery")).toBeNull();
  });
});
