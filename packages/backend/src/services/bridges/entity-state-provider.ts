import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import { Service } from "../../core/ioc/service.js";
import type { HomeAssistantRegistry } from "../home-assistant/home-assistant-registry.js";

const BATTERY_ENUM_PERCENT: Record<string, number> = {
  empty: 0,
  full: 100,
  high: 90,
  low: 20,
  medium: 50,
  normal: 70,
  verylow: 5,
};

export function resolveBatteryPercent(state: string): number | null {
  const numericValue = Number.parseFloat(state);
  if (!Number.isNaN(numericValue)) {
    return numericValue;
  }
  if (state === "off") return 100;
  if (state === "on") return 0;
  return BATTERY_ENUM_PERCENT[state.toLowerCase()] ?? null;
}

/**
 * Service that provides access to Home Assistant entity states.
 * Used by behaviors that need to read states from entities other than their own
 * (e.g., Air Purifier reading filter life from a separate sensor entity).
 */
export class EntityStateProvider extends Service {
  constructor(private readonly registry: HomeAssistantRegistry) {
    super("EntityStateProvider");
  }

  /**
   * Get the current state of an entity by its ID.
   * Returns undefined if the entity doesn't exist or has no state.
   */
  getState(entityId: string): HomeAssistantEntityState | undefined {
    return this.registry.states[entityId];
  }

  /**
   * Get a numeric value from an entity's state.
   * Parses the state string as a number, returns null if not a valid number.
   */
  getNumericState(entityId: string): number | null {
    const state = this.getState(entityId);
    if (!state) {
      return null;
    }
    const value = Number.parseFloat(state.state);
    if (Number.isNaN(value)) {
      return null;
    }
    return value;
  }

  /**
   * Get battery percentage from a battery entity.
   * Handles both numeric sensors (e.g. sensor.battery → "25.0" → 25)
   * and binary sensors (e.g. binary_sensor.battery → off=100%, on=0%).
   * In HA, binary_sensor with device_class=battery uses on=low battery.
   */
  getBatteryPercent(entityId: string): number | null {
    const state = this.getState(entityId);
    if (!state) {
      return null;
    }
    const numericValue = resolveBatteryPercent(state.state);
    return numericValue;
  }
}
