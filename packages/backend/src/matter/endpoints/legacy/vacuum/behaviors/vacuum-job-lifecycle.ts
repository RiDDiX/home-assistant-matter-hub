import {
  type HomeAssistantEntityState,
  VacuumState,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { RvcOperationalState } from "@matter/main/clusters";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { getVacuumBatteryPercent } from "./vacuum-battery.js";

const cycles = new WeakMap<object, { seen: boolean; completed: boolean }>();
const moving = new Set<string>([
  VacuumState.cleaning,
  VacuumState.segment_cleaning,
  VacuumState.zone_cleaning,
  VacuumState.spot_cleaning,
  VacuumState.mop_cleaning,
]);

// undefined: no job mapping (keep the existing fallback); null: temporarily unknown.
export function getVacuumJobActive(agent: Agent): boolean | null | undefined {
  const id = agent.get(HomeAssistantEntityBehavior).state.mapping
    ?.cleaningJobEntity;
  if (!id) return undefined;
  const value = agent.env.get(EntityStateProvider).getState(id)?.state;
  return value === "on" ? true : value === "off" ? false : null;
}

export function getVacuumJobRunMode(
  entity: { state: string },
  agent: Agent,
): number | undefined {
  const active = getVacuumJobActive(agent);
  if (active === undefined) return undefined;
  if (["error", "unavailable", "unknown"].includes(entity.state)) return 0;
  if (active === null) {
    const cycle = cycles.get(agent.endpoint);
    return cycle?.seen && !cycle.completed ? 1 : undefined;
  }
  return active ||
    moving.has(entity.state) ||
    entity.state === VacuumState.paused
    ? 1
    : 0;
}

export function getVacuumJobOperationalState(
  entity: HomeAssistantEntityState,
  agent: Agent,
): RvcOperationalState.OperationalState | undefined {
  if (entity.state !== VacuumState.docked) return undefined;
  const active = getVacuumJobActive(agent);
  if (active === undefined) return undefined;
  const cycle = cycles.get(agent.endpoint);
  if (active === true || (active === null && cycle?.seen && !cycle.completed)) {
    return RvcOperationalState.OperationalState.Paused;
  }
  const percent = getVacuumBatteryPercent(entity, agent);
  if (percent != null && percent >= 100) {
    return RvcOperationalState.OperationalState.Docked;
  }
  return undefined;
}

export function getVacuumJobPhase(entity: { state: string }, agent: Agent) {
  const active = getVacuumJobActive(agent);
  if (active === undefined) return undefined;
  let currentPhase: number | null = null;
  if (moving.has(entity.state) || entity.state === VacuumState.paused)
    currentPhase = 0;
  if (entity.state === VacuumState.returning) currentPhase = 2;
  if (active === true && entity.state === VacuumState.docked) currentPhase = 1;
  // A non-null Matter phase list requires an actual phase index.
  return {
    phaseList:
      currentPhase === null
        ? null
        : ["Cleaning", "Recharging", "Returning to dock"],
    currentPhase,
  };
}

export function shouldCompleteVacuumJob(
  entity: { state: string },
  agent: Agent,
): boolean | undefined {
  const active = getVacuumJobActive(agent);
  if (active === undefined) return undefined;
  if (["unavailable", "unknown"].includes(entity.state)) return false;
  let cycle = cycles.get(agent.endpoint);
  if (!cycle) {
    cycle = { seen: false, completed: false };
    cycles.set(agent.endpoint, cycle);
  }
  if (moving.has(entity.state)) {
    cycle.seen = true;
    cycle.completed = false;
  } else if (active === true && !cycle.completed) {
    // Also recognize an ongoing recharge after a bridge restart.
    cycle.seen = true;
  }
  if (!cycle.seen || cycle.completed) return false;
  const fault = entity.state === VacuumState.error;
  const finished =
    active === false &&
    [VacuumState.returning, VacuumState.docked, VacuumState.idle].some(
      (state) => state === entity.state,
    );
  if (!fault && !finished) return false;
  cycle.completed = true;
  return true;
}
