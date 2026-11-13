import {
  type HomeAssistantEntityState,
  VacuumDeviceFeature,
  VacuumState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import { RvcOperationalState } from "@matter/main/clusters";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { testBit } from "../../../../../utils/test-bit.js";
import { trimToLength } from "../../../../../utils/trim-to-length.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { RvcOperationalStateServer } from "../../../../behaviors/rvc-operational-state-server.js";
import type { ValueSetter } from "../../../../behaviors/utils/cluster-config.js";
import {
  getVacuumBatteryPercent,
  getVacuumChargingState,
  type VacuumChargingState,
} from "./vacuum-battery.js";
import {
  getVacuumJobOperationalState,
  getVacuumJobPhase,
  shouldCompleteVacuumJob,
} from "./vacuum-job-lifecycle.js";
import { mapVacuumOperationalError } from "./vacuum-operational-error.js";
import { getVacuumStartError, readinessReport } from "./vacuum-readiness.js";

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
  // "Fully charged", "Charge complete" and "not_charging" all contain "charg"
  // but mean the opposite, and a stale charging icon must not override a
  // terminal status (#450). Separators normalized so not_charging matches.
  const status =
    typeof attrs.status === "string"
      ? attrs.status.toLowerCase().replace(/[-_]/g, " ")
      : "";
  if (
    status.includes("discharg") ||
    status.includes("not charg") ||
    status.includes("full") ||
    status.includes("complete")
  ) {
    return false;
  }
  if (attrs.battery_icon?.includes("charging")) return true;
  return status.includes("charg");
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
  } else if (state === VacuumState.error) {
    operationalState = RvcOperationalState.OperationalState.Error;
  } else if (state === "unavailable") {
    operationalState = RvcOperationalState.OperationalState.Stopped;
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

// Roborock fault details (#535) when the vacuum reports a genuine error.
function getVacuumFault(entity: { state: string }, agent: Agent) {
  const faultEntity = agent.get(HomeAssistantEntityBehavior).state.mapping
    ?.faultEntity;
  const fault = faultEntity
    ? agent.env.get(EntityStateProvider).getState(faultEntity)?.state
    : undefined;
  return mapVacuumOperationalError(entity.state, fault, !!faultEntity);
}

// A job paused at the dock for a recharge (#536) outranks readiness (#538):
// matter.js forces Error for any non-NoError operationalError.
function getVacuumReadiness(entity: HomeAssistantEntityState, agent: Agent) {
  if (
    getVacuumJobOperationalState(entity, agent) ===
    RvcOperationalState.OperationalState.Paused
  ) {
    return undefined;
  }
  return readinessReport(entity.state, agent);
}

/** Shared with the RvcRunMode pause. */
export const vacuumPause: ValueSetter<void> = (_, agent) => {
  const supportedFeatures =
    agent.get(HomeAssistantEntityBehavior).entity.state.attributes
      .supported_features ?? 0;
  if (testBit(supportedFeatures, VacuumDeviceFeature.PAUSE)) {
    return { action: "vacuum.pause" };
  }
  return { action: "vacuum.stop" };
};

export const VacuumRvcOperationalStateServer = RvcOperationalStateServer({
  getResumeError: getVacuumStartError,
  getAdditionalOperationalStates: (_, agent) =>
    agent.get(HomeAssistantEntityBehavior).state.mapping?.readinessEntity
      ? [RvcOperationalState.OperationalState.UpdatingMaps]
      : [],
  getRecheckAfterMs: (entity, agent) =>
    getVacuumReadiness(entity, agent)?.recheckAfterMs,
  isAtBase: (entity, agent) => {
    if (
      !agent.get(HomeAssistantEntityBehavior).state.mapping?.readinessEntity
    ) {
      return false;
    }
    const base = mapVacuumOperationalState(
      entity,
      getVacuumBatteryPercent(entity, agent),
      getVacuumChargingState(agent),
    );
    return (
      base === RvcOperationalState.OperationalState.Docked ||
      base === RvcOperationalState.OperationalState.Charging
    );
  },
  // An inability to start the NEXT job is not a failure of the job just ended.
  getOperationCompletionError: (entity, agent) =>
    getVacuumFault(entity, agent).errorStateId,
  getOperationalError(entity, agent) {
    const readiness = getVacuumReadiness(entity, agent);
    if (readiness?.kind === "blocked") {
      return {
        errorStateId: RvcOperationalState.ErrorState.UnableToStartOrResume,
        errorStateDetails: trimToLength(readiness.reason, 64, "..."),
      };
    }
    return getVacuumFault(entity, agent);
  },
  getOperationalState(entity, agent): RvcOperationalState.OperationalState {
    const job = getVacuumJobOperationalState(entity, agent);
    if (job === RvcOperationalState.OperationalState.Paused) return job;
    const readiness = readinessReport(entity.state, agent);
    if (readiness?.kind === "updating_maps") {
      return RvcOperationalState.OperationalState.UpdatingMaps;
    }
    if (readiness?.kind === "blocked") {
      return RvcOperationalState.OperationalState.Error;
    }
    return (
      job ??
      mapVacuumOperationalState(
        entity,
        getVacuumBatteryPercent(entity, agent),
        getVacuumChargingState(agent),
      )
    );
  },
  // Only a genuine HA error waits for its fault details, not a readiness block.
  getOperationalErrorSettleMs: (entity, agent) =>
    entity.state === VacuumState.error &&
    agent.get(HomeAssistantEntityBehavior).state.mapping?.faultEntity
      ? 500
      : 0,
  getPhase: getVacuumJobPhase,
  shouldCompleteOperation: shouldCompleteVacuumJob,
  pause: vacuumPause,
  resume: () => ({
    action: "vacuum.start",
  }),
  goHome: () => ({
    action: "vacuum.return_to_base",
  }),
});
