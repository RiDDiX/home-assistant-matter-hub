import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

export interface ReadinessSnapshot {
  state: string;
  last_changed?: string;
}

export interface ReadinessReport {
  kind: "pass_through" | "ready" | "updating_maps" | "blocked";
  reason?: string;
  recheckAfterMs?: number;
}

/** Keep a momentary Ready between saving and downloading from reaching Matter. */
export class VacuumReadiness {
  private mapPending = false;
  private lastKey: string | undefined;
  private readySince: number | undefined;
  private lastReadyChanged: string | undefined;

  read(
    vacuumState: string,
    snapshot: ReadinessSnapshot | undefined,
    now = Date.now(),
  ): ReadinessReport {
    // Readiness is a start precondition. A stale bin/off-dock signal must never
    // hide a real cleaning, paused, returning, error, or unavailable state.
    if (vacuumState !== "idle" && vacuumState !== "docked") {
      this.mapPending = false;
      this.lastKey = undefined;
      this.readySince = undefined;
      this.lastReadyChanged = undefined;
      return { kind: "pass_through" };
    }

    const key = snapshot?.state?.trim().toLowerCase() ?? "unknown";
    if (key !== "ready") this.readySince = undefined;
    if (key === "saving_map" || key === "downloading_map") {
      this.mapPending = true;
      this.lastKey = key;
      return { kind: "updating_maps" };
    }
    if (key === "ready") {
      if (
        this.lastKey !== key ||
        this.readySince === undefined ||
        this.lastReadyChanged !== snapshot?.last_changed
      ) {
        const changed = Date.parse(snapshot?.last_changed ?? "");
        this.readySince = Number.isFinite(changed)
          ? Math.min(changed, now)
          : now;
        this.lastReadyChanged = snapshot?.last_changed;
      }
      this.lastKey = key;
      const remaining = 5000 - (now - this.readySince);
      if (remaining > 0) {
        return {
          kind: this.mapPending ? "updating_maps" : "blocked",
          reason: "Readiness is settling",
          recheckAfterMs: remaining,
        };
      }
      this.mapPending = false;
      return { kind: "ready" };
    }

    this.mapPending = false;
    this.lastKey = key;
    return {
      kind: "blocked",
      reason: ["unknown", "unavailable", ""].includes(key)
        ? "Readiness sensor unavailable"
        : key.replaceAll("_", " "),
    };
  }
}

const readinessTrackers = new WeakMap<object, VacuumReadiness>();

export function readinessReport(
  state: string,
  agent: Agent,
): ReadinessReport | undefined {
  const ha = agent.get(HomeAssistantEntityBehavior);
  const id = ha.state.mapping?.readinessEntity;
  if (!id) return undefined;
  let tracker = readinessTrackers.get(ha.endpoint);
  if (!tracker) {
    tracker = new VacuumReadiness();
    readinessTrackers.set(ha.endpoint, tracker);
  }
  return tracker.read(state, agent.env.get(EntityStateProvider).getState(id));
}

/** Share the status sensor's stable-ready policy with RVC start and resume. */
export function getVacuumStartError(
  entity: HomeAssistantEntityState,
  agent: Agent,
): string | undefined {
  if (!agent.get(HomeAssistantEntityBehavior).state.mapping?.readinessEntity) {
    return undefined;
  }
  // Starting/resuming may be valid mid-mission. Returning, offline and failed
  // robots must not start even if the readiness sensor still says Ready.
  if (
    ![
      "idle",
      "docked",
      "paused",
      "cleaning",
      "segment_cleaning",
      "zone_cleaning",
      "spot_cleaning",
      "mop_cleaning",
    ].includes(entity.state)
  ) {
    return `Vacuum is ${entity.state}`;
  }
  // Status preserves real movement. Commands must evaluate readiness even
  // when paused/cleaning, using the same five-second settling policy.
  const report = readinessReport("idle", agent);
  if (report?.kind === "ready") return undefined;
  return report?.reason ?? "Robot is updating its map";
}
