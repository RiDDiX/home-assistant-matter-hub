import {
  VacuumDeviceFeature,
  VacuumState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { RvcOperationalState } from "@matter/main/clusters";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { RvcOperationalStateServer } from "../../../../behaviors/rvc-operational-state-server.js";
import {
  getVacuumBatteryPercent,
  getVacuumChargingState,
  type VacuumChargingState,
} from "./vacuum-battery.js";

const logger = Logger.get("VacuumRvcOperationalStateServer");

interface ChargingAttributes {
  battery_icon?: string;
  is_charging?: boolean;
  charging?: boolean;
  status?: string;
  battery_level?: number | string | null;
  battery?: number | string | null;
}

function batteryFromAttributes(attrs: Record<string, unknown>): number | null {
  const raw =
    (attrs as ChargingAttributes).battery_level ??
    (attrs as ChargingAttributes).battery;
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

// Conservative charging check for idle: needs an explicit signal, never just a
// low battery (an idle vacuum on the floor at 90% is not charging).
function isCharging(entity: { attributes: Record<string, unknown> }): boolean {
  const attrs = entity.attributes as ChargingAttributes;
  if (attrs.is_charging === true || attrs.charging === true) return true;
  if (attrs.is_charging === false || attrs.charging === false) return false;
  const level = batteryFromAttributes(entity.attributes);
  if (level != null && level >= 100) return false;
  if (attrs.battery_icon?.includes("charging")) return true;
  if (
    typeof attrs.status === "string" &&
    attrs.status.toLowerCase().includes("charg")
  )
    return true;
  return false;
}

// On the dock: an explicit signal wins, otherwise below full means charging,
// which mirrors PowerSource.batChargeState (#377).
function isDockedCharging(
  entity: { attributes: Record<string, unknown> },
  batteryPercent: number | null,
): boolean {
  const attrs = entity.attributes as ChargingAttributes;
  if (attrs.is_charging === true || attrs.charging === true) return true;
  if (attrs.is_charging === false || attrs.charging === false) return false;
  if (batteryPercent != null) return batteryPercent < 100;
  return isCharging(entity);
}

export function mapVacuumOperationalState(
  entity: {
    state: string;
    attributes: Record<string, unknown>;
  },
  batteryPercent: number | null = batteryFromAttributes(entity.attributes),
  chargingState: VacuumChargingState | null = null,
): RvcOperationalState.OperationalState {
  const state = entity.state as VacuumState | "unavailable";

  const cleaningStates: string[] = [
    VacuumState.cleaning,
    VacuumState.segment_cleaning,
    VacuumState.zone_cleaning,
    VacuumState.spot_cleaning,
    VacuumState.mop_cleaning,
  ];

  let operationalState: RvcOperationalState.OperationalState;

  if (state === VacuumState.docked) {
    const charging =
      chargingState != null
        ? chargingState === "charging"
        : isDockedCharging(entity, batteryPercent);
    operationalState = charging
      ? RvcOperationalState.OperationalState.Charging
      : RvcOperationalState.OperationalState.Docked;
  } else if (state === VacuumState.returning) {
    operationalState = RvcOperationalState.OperationalState.SeekingCharger;
  } else if (cleaningStates.includes(state)) {
    operationalState = RvcOperationalState.OperationalState.Running;
  } else if (state === VacuumState.paused) {
    operationalState = RvcOperationalState.OperationalState.Paused;
  } else if (state === VacuumState.idle) {
    // Idle could mean docked/charging or just idle
    const charging =
      chargingState != null ? chargingState === "charging" : isCharging(entity);
    operationalState = charging
      ? RvcOperationalState.OperationalState.Charging
      : RvcOperationalState.OperationalState.Stopped;
  } else if (state === VacuumState.error || state === "unavailable") {
    operationalState = RvcOperationalState.OperationalState.Error;
  } else {
    // Unknown state - log it and treat as Running if it contains "clean"
    if (state.toLowerCase().includes("clean")) {
      logger.info(
        `Unknown vacuum state "${state}" contains 'clean', treating as Running`,
      );
      operationalState = RvcOperationalState.OperationalState.Running;
    } else {
      logger.info(`Unknown vacuum state "${state}", treating as Stopped`);
      operationalState = RvcOperationalState.OperationalState.Stopped;
    }
  }

  logger.debug(
    `Vacuum operationalState: "${state}" -> ${RvcOperationalState.OperationalState[operationalState]}`,
  );
  return operationalState;
}

export const VacuumRvcOperationalStateServer = RvcOperationalStateServer({
  getOperationalState(entity, agent): RvcOperationalState.OperationalState {
    return mapVacuumOperationalState(
      entity,
      getVacuumBatteryPercent(entity, agent),
      getVacuumChargingState(agent),
    );
  },
  pause: (_, agent) => {
    const supportedFeatures =
      agent.get(HomeAssistantEntityBehavior).entity.state.attributes
        .supported_features ?? 0;
    if (testBit(supportedFeatures, VacuumDeviceFeature.PAUSE)) {
      return { action: "vacuum.pause" };
    }
    return { action: "vacuum.stop" };
  },
  resume: () => ({
    action: "vacuum.start",
  }),
  goHome: () => ({
    action: "vacuum.return_to_base",
  }),
});
