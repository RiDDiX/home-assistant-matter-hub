import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import {
  RvcRunModeServer as Base,
  ServiceAreaBehavior,
} from "@matter/main/behaviors";
import { ServiceArea } from "@matter/main/clusters";
import { ModeBase } from "@matter/main/clusters/mode-base";
import { RvcRunMode } from "@matter/main/clusters/rvc-run-mode";
import { EntityStateProvider } from "../../services/bridges/entity-state-provider.js";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import { inferCleanedAreaProgress } from "./infer-cleaned-area-progress.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

const logger = Logger.get("RvcRunModeServer");

export enum RvcSupportedRunMode {
  Idle = 0,
  Cleaning = 1,
}

export interface RvcRunModeServerConfig {
  getCurrentMode: ValueGetter<RvcSupportedRunMode>;
  getSupportedModes: ValueGetter<RvcRunMode.ModeOption[]>;

  start: ValueSetter<void>;
  returnToBase: ValueSetter<void>;
  pause: ValueSetter<void>;
  /** Optional: Clean a specific room by mode value */
  cleanRoom?: ValueSetter<number>;
}

export interface RvcRunModeServerInitialState {
  supportedModes: RvcRunMode.ModeOption[];
  currentMode: number;
}

/** Base mode value for room-specific cleaning modes */
export const ROOM_MODE_BASE = 100;

/** Check if a mode value represents a room-specific cleaning mode */
export function isRoomMode(mode: number): boolean {
  return mode >= ROOM_MODE_BASE;
}

/**
 * Per-endpoint cleaning session state.
 *
 * Stored in a module-level WeakMap keyed by Agent (stable per endpoint)
 * instead of as private instance properties on the behavior class.
 *
 * matter.js behavior methods run on transient proxy instances, private
 * fields reset to their initial value on every invocation.  A WeakMap
 * keyed by the stable Agent identity survives across calls and is
 * automatically cleaned up when the endpoint is garbage-collected.
 */
export interface CleaningSession {
  /** Areas that the vacuum has already finished cleaning in this session */
  completedAreas: Set<number>;
  /** Last known currentArea, used to detect room transitions */
  lastCurrentArea: number | null;
  /** Snapshot of selectedAreas taken when cleaning starts.
   *  serviceArea.state.selectedAreas is controller-managed persistent
   *  state per Matter spec § 1.17.6.3, the controller may change it
   *  mid-session, so progress tracking uses this snapshot for the
   *  lifetime of the cleaning run. */
  activeAreas: number[];
  /** Diagnostic short-circuit reasons already logged this session.
   *  updateCurrentRoomFromSensor() is called on every HA state event;
   *  without this guard a failing path would flood the log. Cleared
   *  when the vacuum returns to Idle. */
  loggedShortCircuits: Set<string>;
  /** True once we've seen the vacuum actually in Cleaning state this
   *  session. Tells real end-of-cleaning from the brief idle right
   *  after dispatch (where we keep currentArea, not clear it). */
  observedCleaning: boolean;
  /** Per-area actions fired one at a time as the vacuum docks between
   *  rooms. Roborock's app_segment_clean replaces the segment list on
   *  each call, so dispatching all N upfront only cleans one room. */
  pendingDispatches: { areaId: number; action: HomeAssistantAction }[];
  /** Cumulative cleaned area (m2) at clean start, so a lifetime sensor maps
   *  to per-clean progress (#368). null when no cleanedAreaEntity is set. */
  cleanedAreaBaseline: number | null;
}

const cleaningSessions = new WeakMap<object, CleaningSession>();

export function getSession(endpoint: object): CleaningSession {
  let session = cleaningSessions.get(endpoint);
  if (!session) {
    session = {
      completedAreas: new Set(),
      lastCurrentArea: null,
      activeAreas: [],
      loggedShortCircuits: new Set(),
      observedCleaning: false,
      pendingDispatches: [],
      cleanedAreaBaseline: null,
    };
    cleaningSessions.set(endpoint, session);
  }
  return session;
}

// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class RvcRunModeServerBase extends Base {
  declare state: RvcRunModeServerBase.State;

  override async initialize() {
    // supportedModes and currentMode are set via .set() before initialize,
    // so matter.js has the modes ready at pairing time.
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    // offline: true makes the reactor run in its own LocalActorContext
    // with a fresh transaction, instead of the parent's postCommit phase.
    // Without this, reactor writes are buffered but never produce
    // subscription reports (the parent transaction has already finalized),
    // so controllers like Apple Home never see state transitions.
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const s = getSession(this.endpoint);
    const previousMode = this.state.currentMode;
    const newMode = this.state.config.getCurrentMode(entity.state, this.agent);

    applyPatchState(
      this.state,
      {
        currentMode: newMode,
        supportedModes: this.state.config.getSupportedModes(
          entity.state,
          this.agent,
        ),
      },
      { force: true },
    );

    // changeToMode already set currentMode=Cleaning, so the cleaning event
    // often arrives without a transition. Latch the flag here instead.
    if (newMode === RvcSupportedRunMode.Cleaning) {
      s.observedCleaning = true;
    }

    if (previousMode !== newMode) {
      if (newMode === RvcSupportedRunMode.Idle) {
        // End of session (or mid-session dock) cleanup.
        //
        // lastCurrentArea is only set when a currentRoomEntity sensor
        // tracks room transitions; finalize the last room only in that
        // case so completedAreas stays accurate.
        if (s.lastCurrentArea !== null) {
          s.completedAreas.add(s.lastCurrentArea);
          s.lastCurrentArea = null;
        }
        // Between-rooms gap: fire the next queued action and skip the
        // end-of-cleaning cleanup. Gated on observedCleaning so the
        // brief idle right after the first dispatch doesn't fire it.
        if (s.pendingDispatches.length > 0 && s.observedCleaning) {
          try {
            const serviceArea = this.agent.get(ServiceAreaBehavior);
            const prev = serviceArea.state.currentArea;
            if (typeof prev === "number") {
              s.completedAreas.add(prev);
            }
            const next = s.pendingDispatches.shift();
            if (next) {
              const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
              homeAssistant.callAction(next.action);
              this.trySetCurrentArea(next.areaId);
            }
          } catch {
            // ServiceArea or HA behavior not available
          }
          s.loggedShortCircuits.clear();
          return;
        }
        // Real end of cleaning. Skip on the brief post-dispatch idle
        // (observedCleaning false there).
        if (s.observedCleaning) {
          try {
            const serviceArea = this.agent.get(ServiceAreaBehavior);
            const last = serviceArea.state.currentArea;
            if (typeof last === "number") {
              s.completedAreas.add(last);
              serviceArea.state.currentArea = null;
            }
            this.updateProgressFromTracking(serviceArea);
          } catch {
            // ServiceArea not available
          }
          s.observedCleaning = false;
        }
        s.loggedShortCircuits.clear();
      } else if (newMode === RvcSupportedRunMode.Cleaning) {
        // Resume after mid-session idle. Set currentArea to the first
        // not-yet-completed area as a fallback; if a currentRoom sensor
        // is configured, updateCurrentRoomFromSensor() below will
        // override this with the actual room the vacuum is in.
        if (s.activeAreas.length > 0 && s.lastCurrentArea === null) {
          const firstPending = s.activeAreas.find(
            (id) => !s.completedAreas.has(id),
          );
          if (firstPending !== undefined) {
            this.trySetCurrentArea(firstPending);
          }
        }
      }
    }

    // The session WeakMap doesn't survive restarts but cluster state
    // does, so currentArea can be stale on boot. Force it null when
    // idle with no active session.
    if (newMode === RvcSupportedRunMode.Idle && s.activeAreas.length === 0) {
      try {
        const serviceArea = this.agent.get(ServiceAreaBehavior);
        if (serviceArea.state.currentArea !== null) {
          serviceArea.state.currentArea = null;
        }
      } catch {
        // ServiceArea not available
      }
    }

    // Dynamic room tracking while cleaning: prefer a currentRoom sensor, else
    // infer the room from a cumulative cleaned-area sensor (#368).
    if (newMode === RvcSupportedRunMode.Cleaning) {
      const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
      if (mapping?.currentRoomEntity) {
        this.updateCurrentRoomFromSensor();
      } else if (mapping?.cleanedAreaEntity) {
        this.updateCurrentRoomFromCleanedArea();
      }
    }
  }

  /**
   * Emit a diagnostic INFO log exactly once per cleaning session for a
   * given short-circuit reason. Prevents log flooding while still
   * surfacing the silent paths that would otherwise be invisible.
   */
  private logShortCircuitOnce(reason: string, message: string) {
    const s = getSession(this.endpoint);
    if (s.loggedShortCircuits.has(reason)) return;
    s.loggedShortCircuits.add(reason);
    logger.info(message);
  }

  /**
   * Read the currentRoomEntity sensor and update currentArea + progress
   * to reflect which room the vacuum is actually in right now.
   */
  private updateCurrentRoomFromSensor() {
    try {
      const s = getSession(this.endpoint);
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const currentRoomEntityId =
        homeAssistant.state.mapping?.currentRoomEntity;
      if (!currentRoomEntityId) {
        this.logShortCircuitOnce(
          "no-mapping",
          "currentRoom sensor: no currentRoomEntity in mapping, " +
            "auto-detect did not run or sensor not on same HA device",
        );
        return;
      }

      const stateProvider = this.agent.env.get(EntityStateProvider);
      const roomState = stateProvider.getState(currentRoomEntityId);
      if (!roomState || !roomState.state) {
        this.logShortCircuitOnce(
          "no-state",
          `currentRoom sensor: no state available for ${currentRoomEntityId}`,
        );
        return;
      }

      const serviceArea = this.agent.get(ServiceAreaBehavior);

      // External-start sessions (HA service call, Roborock app) never run
      // changeToMode, so activeAreas stays []. currentArea must still
      // track the actual room reported by the sensor, so in that case
      // accept any supportedAreas match. With a controller-driven
      // selection (activeAreas populated), keep the strict filter so we
      // don't mis-attribute drive-through rooms the user didn't pick.
      const externalSession = s.activeAreas.length === 0;
      const supportedAreaIds = serviceArea.state.supportedAreas.map(
        (a) => a.areaId,
      );
      const isAllowedArea = (id: number) =>
        externalSession
          ? supportedAreaIds.includes(id)
          : s.activeAreas.includes(id);

      // Match by numeric room/segment ID (preferred) or by room name.
      // Dreame sensors use "room_id", others may use "segment_id".
      const sensorAttrs = roomState.attributes as {
        segment_id?: number;
        room_id?: number;
      };
      const segmentId = sensorAttrs.segment_id ?? sensorAttrs.room_id;
      const roomName = roomState.state;

      let matchedAreaId: number | null = null;

      // Strategy 1: Direct segmentId match (areaId === room_id, e.g. Dreame floor 0).
      if (segmentId != null && isAllowedArea(segmentId)) {
        matchedAreaId = segmentId;
      }

      // Strategy 2: Look up segmentId in supportedAreas to find the
      // corresponding areaId. Dreame multi-floor vacuums offset room IDs
      // per floor (areaId = floorIndex * 10000 + room_id), so the raw
      // sensor room_id won't match directly for floor > 0. Also handles
      // cases where areaId is a hash of a string room ID.
      if (matchedAreaId === null && segmentId != null) {
        for (const area of serviceArea.state.supportedAreas) {
          if (isAllowedArea(area.areaId) && area.areaId % 10000 === segmentId) {
            matchedAreaId = area.areaId;
            break;
          }
        }
      }

      // Strategy 3: Match by location name in supportedAreas.
      if (matchedAreaId === null && roomName) {
        const area = serviceArea.state.supportedAreas.find(
          (a) =>
            a.areaInfo.locationInfo?.locationName?.toLowerCase() ===
            roomName.toLowerCase(),
        );
        if (area && isAllowedArea(area.areaId)) {
          matchedAreaId = area.areaId;
        }
      }

      if (matchedAreaId === null) {
        logger.info(
          `currentRoom sensor: no match for "${roomName}" (segmentId=${segmentId}), ` +
            `activeAreas=[${s.activeAreas.join(", ")}], ` +
            `supportedAreas=[${serviceArea.state.supportedAreas.map((a) => `${a.areaId}:${a.areaInfo.locationInfo?.locationName}`).join(", ")}]`,
        );
        return;
      }
      if (matchedAreaId === s.lastCurrentArea) return;

      // Room transition detected, mark previous area as completed
      if (s.lastCurrentArea !== null) {
        s.completedAreas.add(s.lastCurrentArea);
      }
      s.lastCurrentArea = matchedAreaId;

      logger.info(
        `currentRoom sensor: transition to area ${matchedAreaId} ("${roomName}"), ` +
          `completed: [${[...s.completedAreas].join(", ")}]`,
      );

      this.trySetCurrentArea(matchedAreaId);
    } catch (e) {
      // Only suppress expected errors (EntityStateProvider or ServiceArea not available)
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("No provider for") && !msg.includes("not supported")) {
        logger.warn(`currentRoom sensor update failed: ${msg}`);
      }
    }
  }

  /**
   * Snapshot the controller selection in the order the vacuum will actually
   * clean it. Roborock-class devices clean a batch of segments in ascending
   * id order and ignore the order they were dispatched in, so tracking has
   * to follow that instead of the tap order (#368).
   */
  private orderSelectedAreas(selectedAreas: number[]): number[] {
    const areas = [...selectedAreas];
    try {
      const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
      if (mapping?.vacuumAscendingRoomOrder) {
        areas.sort((a, b) => a - b);
      }
    } catch {
      // HomeAssistant behavior not available
    }
    return areas;
  }

  /** Read the cumulative cleaned-area sensor (m2), or null if not configured. */
  private readCleanedAreaSqm(): number | null {
    try {
      const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
      const entityId = mapping?.cleanedAreaEntity;
      if (!entityId) {
        return null;
      }
      return this.agent.env.get(EntityStateProvider).getNumericState(entityId);
    } catch {
      return null;
    }
  }

  /**
   * For batch vacuums that report cumulative cleaned area but not the current
   * room, infer currentArea + progress from the cleaned area and the per-room
   * sizeSqm. Display-only and batch-only; skipped unless every selected area
   * has a size. The currentRoom sensor path takes priority (#368).
   */
  private updateCurrentRoomFromCleanedArea() {
    try {
      const s = getSession(this.endpoint);
      // Batch only: sequential dispatch already advances currentArea as the
      // vacuum docks between rooms.
      if (s.pendingDispatches.length > 0 || s.activeAreas.length === 0) {
        return;
      }
      const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
      const entityId = mapping?.cleanedAreaEntity;
      if (!entityId) {
        return;
      }
      const raw = this.agent.env
        .get(EntityStateProvider)
        .getNumericState(entityId);
      if (raw == null) {
        this.logShortCircuitOnce(
          "no-cleaned-area-state",
          `cleanedArea sensor: no numeric state for ${entityId}`,
        );
        return;
      }

      // All-or-nothing: only infer when every selected area has a usable size,
      // otherwise leave the first-area fallback in place.
      const customAreas = mapping?.customServiceAreas;
      const ordered: { areaId: number; sizeSqm: number }[] = [];
      // Attribution always walks ascending: with vacuumAscendingRoomOrder set
      // activeAreas already is, and without it this preserves the long-standing
      // assumption that batch vacuums clean rooms in ascending id order (#368).
      for (const areaId of [...s.activeAreas].sort((a, b) => a - b)) {
        const size = customAreas?.[areaId - 1]?.sizeSqm;
        if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
          this.logShortCircuitOnce(
            "no-sizes",
            "cleanedArea sensor: not every selected area has a sizeSqm",
          );
          return;
        }
        ordered.push({ areaId, sizeSqm: size });
      }

      // Re-baseline if the sensor dropped below the baseline (per-clean reset).
      if (s.cleanedAreaBaseline == null || raw < s.cleanedAreaBaseline) {
        s.cleanedAreaBaseline = raw;
      }
      const cleaned = Math.max(0, raw - s.cleanedAreaBaseline);

      const { currentArea, completed } = inferCleanedAreaProgress(
        cleaned,
        ordered,
      );
      logger.debug(
        `cleanedArea: raw=${raw} baseline=${s.cleanedAreaBaseline} ` +
          `cleaned=${cleaned} sizes=[${ordered
            .map((o) => `${o.areaId}:${o.sizeSqm}`)
            .join(",")}] -> current=${currentArea} ` +
          `completed=[${completed.join(",")}]`,
      );
      for (const id of completed) {
        s.completedAreas.add(id);
      }
      if (currentArea === s.lastCurrentArea) {
        return;
      }
      s.lastCurrentArea = currentArea;
      this.trySetCurrentArea(currentArea);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("No provider for") && !msg.includes("not supported")) {
        logger.warn(`cleanedArea room update failed: ${msg}`);
      }
    }
  }

  /**
   * Safely update ServiceArea.currentArea and progress.
   * When areaId is set, marks it as Operating in progress.
   * When areaId is null (Idle), marks all Operating/Pending as Completed.
   * No-op if ServiceArea is not available on this endpoint.
   */
  private trySetCurrentArea(areaId: number | null) {
    try {
      const serviceArea = this.agent.get(ServiceAreaBehavior);
      if (serviceArea.state.currentArea !== areaId) {
        serviceArea.state.currentArea = areaId;
        logger.debug(`currentArea set to ${areaId}`);
      }
      this.updateProgress(serviceArea, areaId);
    } catch {
      // ServiceArea not available on this endpoint
    }
  }

  /**
   * Update progress entries to reflect the current operating area.
   * - null: mark all areas as Completed (cleaning done)
   * - areaId: mark that area as Operating, others as Pending
   *
   * Uses the activeAreas snapshot (plain number array) instead of
   * managed state entries, which avoids infinite recursion in
   * matter.js property getters during transaction pre-commit.
   */
  private updateProgress(
    serviceArea: InstanceType<typeof ServiceAreaBehavior>,
    areaId: number | null,
  ) {
    const s = getSession(this.endpoint);
    if (s.activeAreas.length === 0) return;

    const state = serviceArea.state as typeof serviceArea.state & {
      progress?: ServiceArea.Progress[];
    };

    if (areaId === null) {
      // Cleaning finished, mark all active areas as Completed
      state.progress = s.activeAreas.map((id) => ({
        areaId: id,
        status: ServiceArea.OperationalStatus.Completed,
      }));
    } else {
      // Mark current area as Operating, completed areas as Completed,
      // remaining areas as Pending.
      state.progress = s.activeAreas.map((id) => ({
        areaId: id,
        status:
          id === areaId
            ? ServiceArea.OperationalStatus.Operating
            : s.completedAreas.has(id)
              ? ServiceArea.OperationalStatus.Completed
              : ServiceArea.OperationalStatus.Pending,
      }));
    }
  }

  /**
   * Update progress entries from tracking state without any area
   * operating. Used on mid-session transitions (e.g. vacuum-then-mop
   * tool swap) where the vacuum is temporarily idle but the session
   * is not finished: completed areas stay Completed, remaining areas
   * stay Pending.
   */
  private updateProgressFromTracking(
    serviceArea: InstanceType<typeof ServiceAreaBehavior>,
  ) {
    const s = getSession(this.endpoint);
    if (s.activeAreas.length === 0) return;

    const state = serviceArea.state as typeof serviceArea.state & {
      progress?: ServiceArea.Progress[];
    };

    state.progress = s.activeAreas.map((id) => ({
      areaId: id,
      status: s.completedAreas.has(id)
        ? ServiceArea.OperationalStatus.Completed
        : ServiceArea.OperationalStatus.Pending,
    }));
  }

  /**
   * Stop before finishing: mark the areas the vacuum actually reached as
   * Completed and the rest as Skipped (an out-of-band stop per the Matter
   * ServiceArea spec), then clear currentArea. The old path marked every
   * area Completed, which told Apple Home rooms were cleaned when they were
   * not, so they got dropped from the next selection (#367).
   */
  private finalizeProgressOnStop() {
    const s = getSession(this.endpoint);
    try {
      const serviceArea = this.agent.get(ServiceAreaBehavior);
      if (s.activeAreas.length > 0) {
        const last = serviceArea.state.currentArea;
        const state = serviceArea.state as typeof serviceArea.state & {
          progress?: ServiceArea.Progress[];
        };
        state.progress = s.activeAreas.map((id) => ({
          areaId: id,
          status:
            s.completedAreas.has(id) || id === last
              ? ServiceArea.OperationalStatus.Completed
              : ServiceArea.OperationalStatus.Skipped,
        }));
      }
      serviceArea.state.currentArea = null;
    } catch {
      // ServiceArea not available
    }
  }

  /**
   * Find the ServiceArea area ID that corresponds to a run mode value
   * by matching the mode label to the area location name.
   */
  private findAreaIdForMode(mode: number): number | null {
    try {
      const serviceArea = this.agent.get(ServiceAreaBehavior);
      const modeEntry = this.state.supportedModes.find((m) => m.mode === mode);
      if (!modeEntry) return null;

      const area = serviceArea.state.supportedAreas.find(
        (a) => a.areaInfo.locationInfo?.locationName === modeEntry.label,
      );
      return area?.areaId ?? null;
    } catch {
      return null;
    }
  }

  override changeToMode(
    request: ModeBase.ChangeToModeRequest,
  ): ModeBase.ChangeToModeResponse {
    const s = getSession(this.endpoint);
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const { newMode } = request;

    // Validate mode exists in supportedModes (matches matter.js base behavior)
    if (
      newMode !== this.state.currentMode &&
      !this.state.supportedModes.some((m) => m.mode === newMode)
    ) {
      return {
        status: ModeBase.ModeChangeStatus.UnsupportedMode,
        statusText: `Unsupported mode: ${newMode}`,
      };
    }

    // Check for room-specific cleaning mode
    if (isRoomMode(newMode)) {
      // When selectedAreas exist (e.g. Apple Home sends selectAreas before
      // changeToMode), prefer area-based cleaning over mode-based room selection.
      try {
        const serviceArea = this.agent.get(ServiceAreaBehavior);
        if (serviceArea.state.selectedAreas?.length > 0) {
          // Snapshot selected areas before the start handler clears them
          s.activeAreas = this.orderSelectedAreas(
            serviceArea.state.selectedAreas,
          );
          // Dispatch reads selectedAreas, so write the order back in case the
          // selection was stored before the flag changed (#368).
          serviceArea.state.selectedAreas = [...s.activeAreas];
          s.completedAreas.clear();
          s.lastCurrentArea = null;
          s.loggedShortCircuits.clear();
          s.pendingDispatches = [];
          s.cleanedAreaBaseline = this.readCleanedAreaSqm();
          this.trySetCurrentArea(s.activeAreas[0]);
          homeAssistant.callAction(this.state.config.start(void 0, this.agent));
          this.state.currentMode = newMode;
          return {
            status: ModeBase.ModeChangeStatus.Success,
            statusText: "Starting room cleaning",
          };
        }
      } catch {
        // ServiceArea not available, fall through to mode-based room cleaning
      }

      if (this.state.config.cleanRoom) {
        const areaId = this.findAreaIdForMode(newMode);
        s.activeAreas = areaId !== null ? [areaId] : [];
        s.completedAreas.clear();
        s.lastCurrentArea = null;
        s.loggedShortCircuits.clear();
        s.pendingDispatches = [];
        this.trySetCurrentArea(areaId);
        homeAssistant.callAction(
          this.state.config.cleanRoom(newMode, this.agent),
        );
        this.state.currentMode = newMode;
        return {
          status: ModeBase.ModeChangeStatus.Success,
          statusText: "Starting room cleaning",
        };
      }
    }

    switch (newMode) {
      case RvcSupportedRunMode.Cleaning: {
        // Set currentArea from selectedAreas if a controller pre-selected areas
        try {
          const serviceArea = this.agent.get(ServiceAreaBehavior);
          if (serviceArea.state.selectedAreas?.length > 0) {
            s.activeAreas = this.orderSelectedAreas(
              serviceArea.state.selectedAreas,
            );
            // Same write-back as the area-based branch above (#368).
            serviceArea.state.selectedAreas = [...s.activeAreas];
            s.completedAreas.clear();
            s.lastCurrentArea = null;
            s.loggedShortCircuits.clear();
            s.pendingDispatches = [];
            s.cleanedAreaBaseline = this.readCleanedAreaSqm();
            this.trySetCurrentArea(s.activeAreas[0]);
          }
        } catch {
          // ServiceArea not available
        }
        homeAssistant.callAction(this.state.config.start(void 0, this.agent));
        break;
      }
      case RvcSupportedRunMode.Idle:
        // Explicit user command to stop, clear session state
        this.finalizeProgressOnStop();
        s.completedAreas.clear();
        s.lastCurrentArea = null;
        s.activeAreas = [];
        s.loggedShortCircuits.clear();
        s.pendingDispatches = [];
        s.observedCleaning = false;
        s.cleanedAreaBaseline = null;
        homeAssistant.callAction(
          this.state.config.returnToBase(void 0, this.agent),
        );
        break;
      default:
        homeAssistant.callAction(this.state.config.pause(void 0, this.agent));
        break;
    }
    this.state.currentMode = newMode;
    return {
      status: ModeBase.ModeChangeStatus.Success,
      statusText: "Mode switched",
    };
  }
}

namespace RvcRunModeServerBase {
  export class State extends Base.State {
    config!: RvcRunModeServerConfig;
  }
}

/**
 * Create an RvcRunMode behavior with initial state.
 * The initialState MUST include supportedModes - Matter.js requires this at pairing time.
 */
export function RvcRunModeServer(
  config: RvcRunModeServerConfig,
  initialState?: RvcRunModeServerInitialState,
) {
  const defaultModes: RvcRunMode.ModeOption[] = [
    {
      label: "Idle",
      mode: RvcSupportedRunMode.Idle,
      modeTags: [{ value: RvcRunMode.ModeTag.Idle }],
    },
    {
      label: "Cleaning",
      mode: RvcSupportedRunMode.Cleaning,
      modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }],
    },
  ];

  return RvcRunModeServerBase.set({
    config,
    supportedModes: initialState?.supportedModes ?? defaultModes,
    currentMode: initialState?.currentMode ?? RvcSupportedRunMode.Idle,
  });
}
