import type {
  HomeAssistantEntityState,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

// Battery percent from the mapped battery sensor if one is set (Roomba, Xiaomi,
// Deebot), otherwise the vacuum's own battery attribute. Shared so the power
// source and the operational state read the same value (#377).
export function getVacuumBatteryPercent(
  entity: HomeAssistantEntityState,
  agent: Agent,
): number | null {
  const mapping = agent.get(HomeAssistantEntityBehavior).state.mapping;
  // No battery info for this vacuum when the flag is set. The vacuum always gets
  // a PowerSource, so init strips the attribute but a live update restores it,
  // unless the reader honors the flag on every read (#427).
  if (mapping?.disableBatteryMapping) return null;
  const mapped = mapping?.batteryEntity;
  if (mapped) {
    const battery = agent.env
      .get(EntityStateProvider)
      .getBatteryPercent(mapped);
    if (battery != null) return Math.max(0, Math.min(100, battery));
  }
  const attrs = entity.attributes as VacuumDeviceAttributes;
  const raw = attrs.battery_level ?? attrs.battery;
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  const parsed = Number.parseFloat(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

export type VacuumChargingState = "charging" | "full" | "not_charging";

const CHARGING_STRINGS: Record<string, VacuumChargingState> = {
  charging: "charging",
  go_charging: "charging",
  on: "charging",
  true: "charging",
  full: "full",
  not_charging: "not_charging",
  not_chargeable: "not_charging",
  discharging: "not_charging",
  off: "not_charging",
  false: "not_charging",
};

// Normalize a Home Assistant charging-state value (Xiaomi charging_state,
// a battery_charging binary sensor, etc.) to a charging signal (#377).
export function mapChargingString(raw: string): VacuumChargingState | null {
  return CHARGING_STRINGS[raw.trim().toLowerCase()] ?? null;
}

// Charging signal from the mapped chargingStateEntity, or null when none is set
// (then the caller falls back to the docked/battery inference).
export function getVacuumChargingState(
  agent: Agent,
): VacuumChargingState | null {
  const id = agent.get(HomeAssistantEntityBehavior).state.mapping
    ?.chargingStateEntity;
  if (!id) return null;
  const state = agent.env.get(EntityStateProvider).getState(id);
  if (!state) return null;
  return mapChargingString(state.state);
}
