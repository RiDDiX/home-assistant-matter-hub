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
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
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
 * matter.js behavior methods run on transient proxy instances — private
 * fields reset to their initial value on every invocation.  A WeakMap
 * keyed by the stable Agent identity survives across calls and is
 * automatically cleaned up when the endpoint is garbage-collected.
 */
interface CleaningSession {
  /** Areas that the vacuum has already finished cleaning in this session */
  completedAreas: Set<number>;
  /** Last known currentArea — used to detect room transitions */
  lastCurrentArea: number | null;
  /** Snapshot of selectedAreas taken when cleaning starts.
   *  The start handler clears serviceArea.state.selectedAreas after
   *  dispatching the HA action to prevent re-dispatch, but progress
   *  tracking needs the original list for the entire cleaning session. */
  activeAreas: number[];
  /** Diagnostic short-circuit reasons already logged this session.
   *  updateCurrentRoomFromSensor() is called on every HA state event;
   *  without this guard a failing path would flood the log. Cleared
   *  when the vacuum returns to Idle. */
  loggedShortCircuits: Set<string>;
}

const cleaningSessions = new WeakMap<object, CleaningSession>();

function getSession(endpoint: object): CleaningSession {
  let session = cleaningSessions.get(endpoint);
  if (!session) {
    session = {
      completedAreas: new Set(),
      lastCurrentArea: null,
      activeAreas: [],
      loggedShortCircuits: new Set(),
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
    if (!entity.state?.attributes) {
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

    if (previousMode !== newMode) {
      if (newMode === RvcSupportedRunMode.Idle) {
        // Mid-session dock (e.g. vacuum-then-mop tool swap) or end of
        // session. Finalize the last known cleaning room and preserve
        // completedAreas across the transition so multi-phase sessions
        // don't lose progress when the vacuum returns to the dock.
        // Skip the whole branch when lastCurrentArea is null (brief idle
        // between command dispatch and vacuum actually starting) — the
        // command handler already set currentArea correctly.
        if (s.lastCurrentArea !== null) {
          s.completedAreas.add(s.lastCurrentArea);
          s.lastCurrentArea = null;
          try {
            const serviceArea = this.agent.get(ServiceAreaBehavior);
            serviceArea.state.currentArea = null;
            this.updateProgressFromTracking(serviceArea);
          } catch {
            // ServiceArea not available
          }
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

    // Dynamic room tracking: when cleaning and a currentRoomEntity is
    // configured, read the sensor to update currentArea in real time.
    if (newMode === RvcSupportedRunMode.Cleaning) {
      this.updateCurrentRoomFromSensor();
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
          "currentRoom sensor: no currentRoomEntity in mapping — " +
            "auto-detect did not run or sensor not on same HA device",
        );
        return;
      }

      const stateProvider = this.agent.env.get(EntityStateProvider);
      const roomState = stateProvider.getState(currentRoomEntityId);
      if (!roomState?.state) {
        this.logShortCircuitOnce(
          "no-state",
          `currentRoom sensor: no state available for ${currentRoomEntityId}`,
        );
        return;
      }

      if (s.activeAreas.length === 0) {
        this.logShortCircuitOnce(
          "no-active-areas",
          `currentRoom sensor: activeAreas empty while cleaning — ` +
            `sensor=${currentRoomEntityId} state="${roomState.state}"`,
        );
        return;
      }

      const serviceArea = this.agent.get(ServiceAreaBehavior);

      // Match by numeric room/segment ID (preferred) or by room name.
      // Dreame sensors use "room_id", others may use "segment_id".
      const sensorAttrs = roomState.attributes as {
        segment_id?: number;
        room_id?: number;
      };
      const segmentId = sensorAttrs.segment_id ?? sensorAttrs.room_id;
      const roomName = roomState.state;

      let matchedAreaId: number | null = null;

      // Strategy 1: Direct segmentId → activeAreas match.
      // Works when areaId === room_id (e.g. Dreame floor 0).
      if (segmentId != null) {
        if (s.activeAreas.includes(segmentId)) {
          matchedAreaId = segmentId;
        }
      }

      // Strategy 2: Look up segmentId in supportedAreas to find the
      // corresponding areaId. Dreame multi-floor vacuums offset room IDs
      // per floor (areaId = floorIndex * 10000 + room_id), so the raw
      // sensor room_id won't match activeAreas directly for floor > 0.
      // Also handles cases where areaId is a hash of a string room ID.
      if (matchedAreaId === null && segmentId != null) {
        for (const area of serviceArea.state.supportedAreas) {
          // areaId % 10000 recovers the original per-floor room_id
          // for Dreame multi-floor; for single-floor, areaId === room_id.
          if (
            s.activeAreas.includes(area.areaId) &&
            area.areaId % 10000 === segmentId
          ) {
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
        if (area && s.activeAreas.includes(area.areaId)) {
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

      // Room transition detected — mark previous area as completed
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
      // Cleaning finished — mark all active areas as Completed
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
          s.activeAreas = [...serviceArea.state.selectedAreas];
          s.completedAreas.clear();
          s.lastCurrentArea = null;
          s.loggedShortCircuits.clear();
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
            s.activeAreas = [...serviceArea.state.selectedAreas];
            s.completedAreas.clear();
            s.lastCurrentArea = null;
            s.loggedShortCircuits.clear();
            this.trySetCurrentArea(s.activeAreas[0]);
          }
        } catch {
          // ServiceArea not available
        }
        homeAssistant.callAction(this.state.config.start(void 0, this.agent));
        break;
      }
      case RvcSupportedRunMode.Idle:
        // Explicit user command to stop — clear session state
        this.trySetCurrentArea(null);
        s.completedAreas.clear();
        s.lastCurrentArea = null;
        s.activeAreas = [];
        s.loggedShortCircuits.clear();
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
