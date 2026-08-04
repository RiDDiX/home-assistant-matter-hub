import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import {
  WindowCoveringServer as Base,
  MovementDirection,
  MovementType,
} from "@matter/main/behaviors";
import { WindowCovering } from "@matter/main/clusters";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

const logger = Logger.get("WindowCoveringServer");

import MovementStatus = WindowCovering.MovementStatus;

const FeaturedBase = Base.with(
  "Lift",
  "PositionAwareLift",
  "Tilt",
  "PositionAwareTilt",
);

export interface WindowCoveringConfig {
  getCurrentLiftPosition: ValueGetter<number | null>;
  getCurrentTiltPosition: ValueGetter<number | null>;
  getMovementStatus: ValueGetter<MovementStatus>;

  /**
   * Where getCurrentLiftPosition / getCurrentTiltPosition will land once HA
   * parks the cover at an end, as a percent in that same stored space.
   * "open" / "close" are HA ends, not Matter intents: the caller resolves which
   * HA action really fires (swap included) and asks for that end. Optional; the
   * completion check falls back to the Matter target without it (#429).
   */
  getExpectedRestPosition?: (
    end: "open" | "close",
    agent: Agent,
  ) => number | null;

  /**
   * One line naming the flags that decide which HA service fires and which
   * space the stored positions live in, for the command log. Resolved by the
   * config itself so the diagnostic reads exactly what the dispatch and the
   * position conversion read, and cannot drift from them (#429).
   */
  getDiagnosticFlags?: (agent: Agent) => string;

  // Override the feature-derived Type / EndProductType. Used to tell
  // controllers the covering is a curtain/shutter/awning instead of the
  // default Rollershade (#304).
  getCoverType?: ValueGetter<WindowCovering.WindowCoveringType | undefined>;
  getEndProductType?: ValueGetter<WindowCovering.EndProductType | undefined>;

  stopCover: ValueSetter<void>;
  openCoverLift: ValueSetter<void>;
  closeCoverLift: ValueSetter<void>;
  /**
   * "cover.set_cover_position", {
   *       tilt_position: targetPosition,
   *     }
   * invertPercentage?: boolean;
   * swapOpenAndClose?: boolean;
   */
  setLiftPosition: ValueSetter<number>;

  openCoverTilt: ValueSetter<void>;
  closeCoverTilt: ValueSetter<void>;
  /**
   * "cover.set_cover_tilt_position", {
   *       tilt_position: targetPosition,
   *     }
   *     invertPercentage?: boolean;
   * swapOpenAndClose?: boolean;
   */
  setTiltPosition: ValueSetter<number>;
}

// Everything needed for a debounced HA call. entityId and actions must be
// captured before setTimeout because the agent context expires after the
// command handler returns.
interface CoverPendingAction {
  action: HomeAssistantAction;
  entityId: string;
  actions: HomeAssistantActions;
}

// matter.js runs each controller command on a throwaway proxy instance, so
// instance fields reset every call and the second slider command can't
// clearTimeout the first command's timer, firing both HA actions and making
// coverSliderDebounceMs a no-op. Keep the debounce timers and pending actions
// in a module-level registry keyed by the persistent Endpoint object instead,
// following the RvcRunMode session precedent (#411).
interface CoverDebounceState {
  liftTimer: ReturnType<typeof setTimeout> | null;
  tiltTimer: ReturnType<typeof setTimeout> | null;
  pendingLift: CoverPendingAction | null;
  pendingTilt: CoverPendingAction | null;
  // Track when the last command was received to implement two-phase debounce
  lastLiftCommandTime: number;
  lastTiltCommandTime: number;
}

const coverDebounce = new WeakMap<object, CoverDebounceState>();

// When a Matter controller starts a move but the HA integration never surfaces
// an opening/closing transitional state (e.g. SONOFF via SonoffLAN), we hold an
// optimistic Opening/Closing so the controller gets a moving->stopped edge (#429).
// If HA never confirms completion, drop the optimistic status after this long so
// the controller can't show "Opening" forever.
const DEFAULT_OPTIMISTIC_MOVEMENT_TIMEOUT_MS = 120_000; // 120s safety net
let optimisticMovementTimeoutMs = DEFAULT_OPTIMISTIC_MOVEMENT_TIMEOUT_MS;

// Test seam: shrink the safety timeout so the expiry path is reachable without a
// 120s wait. Production code never calls this.
export function setOptimisticMovementTimeoutMsForTests(ms: number): void {
  optimisticMovementTimeoutMs = ms;
}
export { DEFAULT_OPTIMISTIC_MOVEMENT_TIMEOUT_MS };

function getCoverDebounce(endpoint: object): CoverDebounceState {
  let st = coverDebounce.get(endpoint);
  if (!st) {
    st = {
      liftTimer: null,
      tiltTimer: null,
      pendingLift: null,
      pendingTilt: null,
      lastLiftCommandTime: 0,
      lastTiltCommandTime: 0,
    };
    coverDebounce.set(endpoint, st);
  }
  return st;
}

// A discrete open/close/stop must drop a pending debounced position, or the
// stale set_cover_position fires afterwards and the cover moves again (#411).
function clearPendingLift(st: CoverDebounceState) {
  if (st.liftTimer) {
    clearTimeout(st.liftTimer);
    st.liftTimer = null;
  }
  st.pendingLift = null;
}

function clearPendingTilt(st: CoverDebounceState) {
  if (st.tiltTimer) {
    clearTimeout(st.tiltTimer);
    st.tiltTimer = null;
  }
  st.pendingTilt = null;
}

// Optimistic movement per axis (#429). A Matter command records the direction it
// started and when, so update() can hold that Opening/Closing until HA confirms
// completion, a StopMotion arrives, or the safety timeout elapses. Keyed on the
// persistent endpoint for the same reason as coverDebounce: matter.js runs each
// command on a throwaway instance, so instance fields would not survive to the
// later HA onChange tick.
interface CoverOptimisticAxis {
  status: MovementStatus;
  startedAt: number;
  // Active safety-net timer that writes Stopped if HA never confirms (#429).
  timer: ReturnType<typeof setTimeout> | null;
  // The HA end the dispatched action parks at, or null when the Matter target
  // is the right thing to compare against. Kept as the END, not a number, so
  // the check resolves through the CURRENT flag conversion on every tick and a
  // mid-move bridge flag edit cannot split the comparison across spaces.
  expectedRestEnd: "open" | "close" | null;
}

interface CoverOptimisticState {
  lift: CoverOptimisticAxis | null;
  tilt: CoverOptimisticAxis | null;
}

const coverOptimistic = new WeakMap<object, CoverOptimisticState>();

// Which HA end the dispatched action drives the cover to. Only the discrete
// open/close services park at an end; the position services land on the target
// itself, so those get no expectation and keep the target comparison. Reading
// the resolved action instead of the Matter intent is what makes a per-entity
// coverSwapOpenClose land in the right place (#429).
function haRestEnd(action: HomeAssistantAction): "open" | "close" | null {
  if (action.action.includes("open_cover")) {
    return "open";
  }
  if (action.action.includes("close_cover")) {
    return "close";
  }
  return null;
}

// One HA percent, in Matter 100ths. HA reports whole percents, so every stored
// position is a multiple of this and a difference of exactly one unit is the
// smallest real move a cover can make, not rounding noise.
const POSITION_TOLERANCE_100THS = 100;

// Strict, so effectively "same position": a one percent command must never be
// mistaken for a no-op, or the smallest slider step is dropped before it
// reaches HA. Used by the command-skip guards and the at-rest guard.
function isExactPosition(a: number, b: number): boolean {
  return Math.abs(a - b) < POSITION_TOLERANCE_100THS;
}

// Inclusive, and only for judging a finished move: a cover parking exactly one
// percent short of where it was sent has arrived, and holding the moving label
// on that single unit stranded it until the safety timeout (#429).
function withinRestTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= POSITION_TOLERANCE_100THS;
}

function getCoverOptimistic(endpoint: object): CoverOptimisticState {
  let st = coverOptimistic.get(endpoint);
  if (!st) {
    st = { lift: null, tilt: null };
    coverOptimistic.set(endpoint, st);
  }
  return st;
}

// Drop an optimistic entry and cancel its safety timer together, so no stray
// timeout writes Stopped after the entry was already resolved (#429).
function clearOptimisticAxis(st: CoverOptimisticState, axis: "lift" | "tilt") {
  const entry = st[axis];
  if (entry?.timer) {
    clearTimeout(entry.timer);
  }
  st[axis] = null;
}

export class WindowCoveringServerBase extends FeaturedBase {
  declare state: WindowCoveringServerBase.State;

  // Written and read within one synchronous command (upOrOpen fires lift then
  // tilt on the same instance), so these stay as instance fields (#246).
  private lastLiftMovementMs = 0;
  private lastLiftMovementDirection: MovementDirection | null = null;
  // Two-phase debounce: longer for first command (quick swipe sends initial step value),
  // shorter for subsequent commands during drag
  private static readonly DEBOUNCE_INITIAL_MS = 400;
  private static readonly DEBOUNCE_SUBSEQUENT_MS = 150;
  private static readonly COMMAND_SEQUENCE_THRESHOLD_MS = 600;

  // Per-entity override wins over per-bridge flag; both must be > 0 to count.
  private resolveDebounceOverride(
    homeAssistant: HomeAssistantEntityBehavior,
  ): number | null {
    const fromEntity = homeAssistant.state.mapping?.coverSliderDebounceMs;
    if (typeof fromEntity === "number" && fromEntity > 0) {
      return fromEntity;
    }
    const fromBridge =
      this.env.get(BridgeDataProvider).featureFlags?.coverSliderDebounceMs;
    if (typeof fromBridge === "number" && fromBridge > 0) {
      return fromBridge;
    }
    return null;
  }

  override async [Symbol.asyncDispose]() {
    // this.endpoint is valid on the dispose instance, so this clears the real
    // timers held in the registry (the fields on this instance never held them).
    const st = coverDebounce.get(this.endpoint);
    if (st) {
      clearPendingLift(st);
      clearPendingTilt(st);
      coverDebounce.delete(this.endpoint);
    }
    const optimistic = coverOptimistic.get(this.endpoint);
    if (optimistic) {
      // Cancel the safety timers before dropping the registry entry.
      clearOptimisticAxis(optimistic, "lift");
      clearOptimisticAxis(optimistic, "tilt");
      coverOptimistic.delete(this.endpoint);
    }
    await super[Symbol.asyncDispose]();
  }

  override async initialize() {
    // Match the certified Eve MotionBlinds cluster profile (#328): HAMH owns
    // operationalStatus, so disable matter.js's auto reactors, and leave the
    // deprecated Percentage attrs undefined so they drop out of AttributeList.
    (
      this as unknown as {
        internal: { disableOperationalModeHandling: boolean };
      }
    ).internal.disableOperationalModeHandling = true;
    if (this.features.positionAwareLift) {
      this.state.currentPositionLiftPercentage = undefined;
      if (this.state.currentPositionLiftPercent100ths === undefined) {
        this.state.currentPositionLiftPercent100ths = null;
      }
      if (this.state.targetPositionLiftPercent100ths === undefined) {
        this.state.targetPositionLiftPercent100ths = null;
      }
    }
    if (this.features.positionAwareTilt) {
      this.state.currentPositionTiltPercentage = undefined;
      if (this.state.currentPositionTiltPercent100ths === undefined) {
        this.state.currentPositionTiltPercent100ths = null;
      }
      if (this.state.targetPositionTiltPercent100ths === undefined) {
        this.state.targetPositionTiltPercent100ths = null;
      }
    } else if (this.features.tilt) {
      // Tilt without PositionAwareTilt: the percent attrs aren't allowed here.
      // Drop them so super.initialize's target = current write can't crash (#381).
      const tiltState = this.state as {
        currentPositionTiltPercentage?: number | null;
        currentPositionTiltPercent100ths?: number | null;
        targetPositionTiltPercent100ths?: number | null;
      };
      tiltState.currentPositionTiltPercentage = undefined;
      tiltState.currentPositionTiltPercent100ths = undefined;
      tiltState.targetPositionTiltPercent100ths = undefined;
    }

    // Default Rollershade fails conformance for tilt-capable covers (#323).
    this.state.type =
      this.features.lift && this.features.tilt
        ? WindowCovering.WindowCoveringType.TiltBlindLift
        : this.features.tilt
          ? WindowCovering.WindowCoveringType.TiltBlindTiltOnly
          : WindowCovering.WindowCoveringType.Rollershade;

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const config = this.state.config;
    const state = entity.state as HomeAssistantEntityState;
    const movementStatus = config.getMovementStatus(state, this.agent);

    const normalize = (value: number | null) => {
      if (value == null) {
        return value;
      }
      return Math.min(100, Math.abs(value));
    };

    const currentLift = normalize(
      config.getCurrentLiftPosition(state, this.agent),
    );
    const currentLift100ths = currentLift != null ? currentLift * 100 : null;
    const currentTilt = normalize(
      config.getCurrentTiltPosition(state, this.agent),
    );
    const currentTilt100ths = currentTilt != null ? currentTilt * 100 : null;

    // Overlay optimistic movement (#429). A Matter command may have written an
    // Opening/Closing that HA cannot confirm with a transitional state (SONOFF
    // via SonoffLAN only ever reports open/closed). HA transitional states always
    // win and drop the guess; otherwise hold the optimistic value until the axis
    // reaches its commanded target, a StopMotion arrives, or the timeout elapses.
    const optimistic = getCoverOptimistic(this.endpoint);
    const resolveAxisStatus = (
      axis: "lift" | "tilt",
      positionAware: boolean,
      current100ths: number | null,
      existingTarget: number | null | undefined,
    ): MovementStatus => {
      if (movementStatus !== MovementStatus.Stopped) {
        clearOptimisticAxis(optimistic, axis);
        return movementStatus;
      }
      const entry = optimistic[axis];
      if (!entry) {
        return MovementStatus.Stopped;
      }
      // Position-aware axes complete when current meets the position the command
      // is really heading for. The Matter target only works when the stored
      // position space matches Matter's; a non-inverting space or a per-entity
      // swap parks the cover somewhere else, so the command records its own
      // expectation and that wins here (#429). This is the ONE inclusive check:
      // a landing up to one percent shy still counts as reached, while the
      // command-skip guards stay strict so a one percent move still dispatches.
      // Non-position-aware axes have nothing to compare, so they clear only via
      // HA transitional states, StopMotion, or the timeout.
      const getExpected = config.getExpectedRestPosition;
      const expectedPercent =
        entry.expectedRestEnd != null && getExpected != null
          ? getExpected(entry.expectedRestEnd, this.agent)
          : null;
      const goal =
        expectedPercent != null ? expectedPercent * 100 : existingTarget;
      const reachedTarget =
        positionAware &&
        current100ths != null &&
        goal != null &&
        withinRestTolerance(current100ths, goal);
      const expired =
        Date.now() - entry.startedAt >= optimisticMovementTimeoutMs;
      if (reachedTarget || expired) {
        clearOptimisticAxis(optimistic, axis);
        return MovementStatus.Stopped;
      }
      return entry.status;
    };

    const liftStatus = this.features.lift
      ? resolveAxisStatus(
          "lift",
          this.features.positionAwareLift,
          currentLift100ths,
          this.state.targetPositionLiftPercent100ths,
        )
      : MovementStatus.Stopped;
    const tiltStatus = this.features.tilt
      ? resolveAxisStatus(
          "tilt",
          this.features.positionAwareTilt,
          currentTilt100ths,
          this.state.targetPositionTiltPercent100ths,
        )
      : MovementStatus.Stopped;
    // Matter global mirrors matter.js: whichever axis moves, lift winning ties.
    const globalStatus =
      liftStatus !== MovementStatus.Stopped ? liftStatus : tiltStatus;

    // When an axis is stopped, its target MUST equal its current position, or
    // controllers such as Google Home show a stale position. When it moves with
    // no Matter command (HA / physical button) the stale target misleads Apple
    // Home, which derives direction from current-vs-target, so override it with
    // the direction limit (#268). Driven per axis by the effective status above.
    const inferTarget = (
      status: MovementStatus,
      current100ths: number | null,
      existing100ths: number | null | undefined,
    ): number | null => {
      if (status === MovementStatus.Stopped) return current100ths;
      if (status === MovementStatus.Opening) {
        // Moving towards 0 (open). Keep target only if it is ahead (< current).
        if (
          existing100ths != null &&
          current100ths != null &&
          existing100ths < current100ths
        ) {
          return existing100ths;
        }
        return 0;
      }
      if (status === MovementStatus.Closing) {
        // Moving towards 10000 (closed). Keep target only if it is ahead (> current).
        if (
          existing100ths != null &&
          current100ths != null &&
          existing100ths > current100ths
        ) {
          return existing100ths;
        }
        return 10000;
      }
      return existing100ths ?? current100ths;
    };

    logger.debug(
      `Cover update for ${entity.entity_id}: state=${state.state}, lift=${currentLift}%, tilt=${currentTilt}%, ha=${MovementStatus[movementStatus]}, effective=${MovementStatus[globalStatus]}`,
    );

    const overrideType = config.getCoverType?.(state, this.agent);
    const overrideEndProduct = config.getEndProductType?.(state, this.agent);

    // On the Stopped -> Moving transition, write only operationalStatus and
    // target. Apple Home derives direction from target-vs-current; if a fresh
    // current update lands at the controller before/with the new target, the
    // UI briefly shows the wrong direction. Skipping current here lets the
    // first subscription report carry state + target alone, and the next HA
    // tick (~50-1000ms later) carries current on its own (#328).
    const previousStatus = (
      this.state.operationalStatus as { global?: number } | undefined
    )?.global;
    const startedMoving =
      globalStatus !== MovementStatus.Stopped &&
      previousStatus === MovementStatus.Stopped;

    const appliedPatch = applyPatchState<WindowCoveringServerBase.State>(
      this.state,
      {
        type:
          overrideType ??
          (this.features.lift && this.features.tilt
            ? WindowCovering.WindowCoveringType.TiltBlindLift
            : this.features.tilt
              ? WindowCovering.WindowCoveringType.TiltBlindTiltOnly
              : WindowCovering.WindowCoveringType.Rollershade),
        endProductType:
          overrideEndProduct ??
          (this.features.lift && this.features.tilt
            ? WindowCovering.EndProductType.SheerShade
            : this.features.tilt
              ? WindowCovering.EndProductType.TiltOnlyInteriorBlind
              : WindowCovering.EndProductType.RollerShade),
        // Target before operationalStatus so the wire order matches the
        // certified Eve MotionBlinds (state, target, current). Patch insertion
        // order propagates into matter.js's changeList via for-in over values
        // (Datasource.js:414), then through attrsChanged.emit (#328).
        ...(this.features.positionAwareLift
          ? {
              targetPositionLiftPercent100ths: inferTarget(
                liftStatus,
                currentLift100ths,
                this.state.targetPositionLiftPercent100ths,
              ),
            }
          : {}),
        ...(this.features.positionAwareTilt
          ? {
              targetPositionTiltPercent100ths: inferTarget(
                tiltStatus,
                currentTilt100ths,
                this.state.targetPositionTiltPercent100ths,
              ),
            }
          : {}),
        operationalStatus: {
          global: globalStatus,
          ...(this.features.lift ? { lift: liftStatus } : {}),
          ...(this.features.tilt ? { tilt: tiltStatus } : {}),
        },
        ...(this.features.positionAwareLift && !startedMoving
          ? {
              currentPositionLiftPercent100ths: currentLift100ths,
            }
          : {}),
        ...(this.features.positionAwareTilt && !startedMoving
          ? {
              currentPositionTiltPercent100ths: currentTilt100ths,
            }
          : {}),
      },
    );

    if (Object.keys(appliedPatch).length > 0) {
      // Log operational status changes (movement start/stop) at INFO,
      // position-only updates at DEBUG to avoid flooding the log.
      const hasOperationalChange = "operationalStatus" in appliedPatch;
      const log = hasOperationalChange ? logger.info : logger.debug;
      log.call(
        logger,
        `Cover ${entity.entity_id} state changed: ${JSON.stringify(appliedPatch)}`,
      );
    }
  }

  // Write operationalStatus for the moved axis in the command interaction while
  // preserving the other axis. matter.js's own reactors are disabled (#328), so
  // this is the only writer. Global mirrors matter.js: lift wins, else tilt.
  private writeOperationalStatus(overrides: {
    lift?: MovementStatus;
    tilt?: MovementStatus;
  }) {
    const current = this.state.operationalStatus as
      | {
          global?: MovementStatus;
          lift?: MovementStatus;
          tilt?: MovementStatus;
        }
      | undefined;
    const lift = this.features.lift
      ? (overrides.lift ?? current?.lift ?? MovementStatus.Stopped)
      : undefined;
    const tilt = this.features.tilt
      ? (overrides.tilt ?? current?.tilt ?? MovementStatus.Stopped)
      : undefined;
    const global =
      lift != null && lift !== MovementStatus.Stopped
        ? lift
        : (tilt ?? MovementStatus.Stopped);
    this.state.operationalStatus = {
      global,
      ...(this.features.lift ? { lift } : {}),
      ...(this.features.tilt ? { tilt } : {}),
    };
  }

  // At rest target MUST equal current. matter.js pre-writes target 0/10000 for
  // the command it is about to run and its own snap is skipped while operational
  // mode handling is disabled (WindowCoveringServer.js:322-335, #328), so any
  // path that ends a move without an HA tick has to do it here.
  private snapTargetToCurrent(axis: "lift" | "tilt") {
    if (axis === "lift") {
      if (!this.features.positionAwareLift) return;
      const current = this.state.currentPositionLiftPercent100ths;
      if (current != null) {
        this.state.targetPositionLiftPercent100ths = current;
      }
      return;
    }
    if (!this.features.positionAwareTilt) return;
    const current = this.state.currentPositionTiltPercent100ths;
    if (current != null) {
      this.state.targetPositionTiltPercent100ths = current;
    }
  }

  // Is the axis already parked where the dispatched action would drive it? Uses
  // the live rest-position hook so the answer is resolved in the stored space,
  // flags and swap included, instead of re-deriving them here (#429). Strict:
  // a cover one percent off the end really does move, so it must report the
  // move; the inclusive completion check clears it again on landing.
  private isAtExpectedRest(
    axis: "lift" | "tilt",
    end: "open" | "close" | null,
  ): boolean {
    const positionAware =
      axis === "lift"
        ? this.features.positionAwareLift
        : this.features.positionAwareTilt;
    if (!positionAware || end == null) {
      return false;
    }
    const expected = this.state.config.getExpectedRestPosition?.(
      end,
      this.agent,
    );
    const current =
      axis === "lift"
        ? this.state.currentPositionLiftPercent100ths
        : this.state.currentPositionTiltPercent100ths;
    if (expected == null || current == null) {
      return false;
    }
    return isExactPosition(current, expected * 100);
  }

  // The action moves nothing, so HA reports no state change and an optimistic
  // Opening/Closing would sit there until the safety timeout. Just line the
  // attributes up with the rest the axis is provably already at.
  private settleAtRest(axis: "lift" | "tilt") {
    this.snapTargetToCurrent(axis);
    const optimistic = getCoverOptimistic(this.endpoint);
    if (optimistic[axis]) {
      clearOptimisticAxis(optimistic, axis);
      this.writeOperationalStatus({ [axis]: MovementStatus.Stopped });
    }
  }

  // Record the optimistic direction and emit it now so a controller gets the
  // moving->stopped edge even when HA never reports a transitional state (#429).
  private startOptimisticMovement(
    axis: "lift" | "tilt",
    status: MovementStatus,
    expectedRestEnd: "open" | "close" | null,
  ) {
    const optimistic = getCoverOptimistic(this.endpoint);
    // A fresh movement on this axis supersedes any pending safety timer.
    clearOptimisticAxis(optimistic, axis);

    // Capture plain values before the timer: the agent context and this proxy
    // instance expire after the handler, so the callback may only touch the
    // persistent endpoint (see this file's header comment and #429).
    const endpoint = this.endpoint;
    const hasLift = this.features.lift;
    const hasTilt = this.features.tilt;
    const hasPositionLift = this.features.positionAwareLift;
    const hasPositionTilt = this.features.positionAwareTilt;
    const startedAt = Date.now();

    // The passive expiry in update() only runs on the next HA onChange. If HA
    // falls silent after the command, this timer writes Stopped instead,
    // keeping the other axis' status. No agent context here, hence setStateOf.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const st = coverOptimistic.get(endpoint);
          const entry = st?.[axis];
          if (
            !entry ||
            Date.now() - entry.startedAt < optimisticMovementTimeoutMs
          ) {
            return;
          }
          st[axis] = null; // this timer is the one firing; nothing to clear
          const other = axis === "lift" ? "tilt" : "lift";
          const otherStatus = st[other]?.status ?? MovementStatus.Stopped;
          const liftStatus =
            axis === "lift" ? MovementStatus.Stopped : otherStatus;
          const tiltStatus =
            axis === "tilt" ? MovementStatus.Stopped : otherStatus;
          const global =
            liftStatus !== MovementStatus.Stopped ? liftStatus : tiltStatus;
          // Stopped requires target = current, and target rides before
          // operationalStatus on the wire, same as update().
          const wc =
            (
              endpoint.state as {
                windowCovering?: {
                  currentPositionLiftPercent100ths?: number | null;
                  currentPositionTiltPercent100ths?: number | null;
                };
              }
            ).windowCovering ?? {};
          await endpoint.setStateOf(WindowCoveringServerBase, {
            ...(axis === "lift" &&
            hasPositionLift &&
            wc.currentPositionLiftPercent100ths != null
              ? {
                  targetPositionLiftPercent100ths:
                    wc.currentPositionLiftPercent100ths,
                }
              : {}),
            ...(axis === "tilt" &&
            hasPositionTilt &&
            wc.currentPositionTiltPercent100ths != null
              ? {
                  targetPositionTiltPercent100ths:
                    wc.currentPositionTiltPercent100ths,
                }
              : {}),
            operationalStatus: {
              global,
              ...(hasLift ? { lift: liftStatus } : {}),
              ...(hasTilt ? { tilt: tiltStatus } : {}),
            },
          });
        } catch (error) {
          logger.debug(
            `Optimistic ${axis} timeout write failed (endpoint may be closing): ${error}`,
          );
        }
      })();
    }, optimisticMovementTimeoutMs);
    // A safety net must not keep the event loop alive by itself.
    (timer as { unref?: () => void }).unref?.();

    optimistic[axis] = { status, startedAt, timer, expectedRestEnd };
    this.writeOperationalStatus({ [axis]: status });
  }

  override async handleMovement(
    type: MovementType,
    _: boolean,
    direction: MovementDirection,
    targetPercent100ths?: number,
  ) {
    const currentLift = this.state.currentPositionLiftPercent100ths ?? 0;
    const currentTilt = this.state.currentPositionTiltPercent100ths ?? 0;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    // Logged verbatim: the config owns the resolution, this only prints it.
    const flags = this.state.config.getDiagnosticFlags?.(this.agent);

    logger.info(
      `handleMovement ${homeAssistant.entityId}: type=${MovementType[type]}, direction=${MovementDirection[direction]}, target=${targetPercent100ths}, currentLift=${currentLift}, currentTilt=${currentTilt}${flags ? `, ${flags}` : ""}`,
    );

    // Boundary targets (0=open, 10000=closed per Matter spec) are routed
    // directly to open/close handlers regardless of the direction computed
    // by matter.js. The direction computation relies on currentPosition which
    // can be in HA semantics (non-inverted) when coverUseHomeAssistantPercentage
    // is enabled, causing matter.js to derive the wrong direction.
    if (type === MovementType.Lift) {
      this.lastLiftMovementMs = Date.now();
      this.lastLiftMovementDirection = direction;
      if (targetPercent100ths === 0) {
        this.handleLiftOpen();
      } else if (targetPercent100ths === 10000) {
        this.handleLiftClose();
      } else if (
        targetPercent100ths != null &&
        this.features.positionAwareLift
      ) {
        this.handleGoToLiftPosition(targetPercent100ths);
      } else if (direction === MovementDirection.Open) {
        this.handleLiftOpen();
      } else if (direction === MovementDirection.Close) {
        this.handleLiftClose();
      }
    } else if (type === MovementType.Tilt) {
      // When lift was just triggered in the same direction (within the same
      // downOrClose / upOrOpen call) and tilt has no specific target, skip
      // the redundant tilt action. KNX and similar actuators interpret the
      // rapid close_cover + close_cover_tilt as a stop command (#246).
      if (
        targetPercent100ths == null &&
        this.lastLiftMovementDirection === direction &&
        Date.now() - this.lastLiftMovementMs < 50
      ) {
        logger.info(
          `Skipping tilt ${MovementDirection[direction]}, lift already moving in same direction`,
        );
        return;
      }
      if (targetPercent100ths === 0) {
        this.handleTiltOpen();
      } else if (targetPercent100ths === 10000) {
        this.handleTiltClose();
      } else if (
        targetPercent100ths != null &&
        this.features.positionAwareTilt
      ) {
        this.handleGoToTiltPosition(targetPercent100ths);
      } else if (direction === MovementDirection.Open) {
        this.handleTiltOpen();
      } else if (direction === MovementDirection.Close) {
        this.handleTiltClose();
      }
    }
  }

  override handleStopMovement() {
    const st = getCoverDebounce(this.endpoint);
    clearPendingLift(st);
    clearPendingTilt(st);

    // The stop ends any optimistic move: drop the entries (and their safety
    // timers) and report Stopped now so a controller clears its optimistic label
    // even if HA sends no follow-up.
    const optimistic = getCoverOptimistic(this.endpoint);
    clearOptimisticAxis(optimistic, "lift");
    clearOptimisticAxis(optimistic, "tilt");
    // The interrupted command left target at the position it aimed for. Snap it
    // back before the status write, so the wire order stays target then status.
    this.snapTargetToCurrent("lift");
    this.snapTargetToCurrent("tilt");
    this.writeOperationalStatus({
      ...(this.features.lift ? { lift: MovementStatus.Stopped } : {}),
      ...(this.features.tilt ? { tilt: MovementStatus.Stopped } : {}),
    });

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(this.state.config.stopCover(void 0, this.agent));
  }

  private handleLiftOpen() {
    clearPendingLift(getCoverDebounce(this.endpoint));

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.openCoverLift(void 0, this.agent);
    const end = haRestEnd(action);
    const atRest = this.isAtExpectedRest("lift", end);

    // Matter open intent = moving towards 0 = Opening, independent of the HA
    // swap flag (swap only picks which HA service fires, not the Matter-side
    // direction the controller sees). Completion is judged against where that
    // service parks the cover, which is not the Matter target in every space.
    // Already there = nothing to report, but HA still gets the command.
    if (atRest) {
      this.settleAtRest("lift");
    } else {
      this.startOptimisticMovement("lift", MovementStatus.Opening, end);
    }

    logger.info(
      `handleLiftOpen ${homeAssistant.entityId}: calling action=${action.action}, atRest=${atRest}, ${this.state.config.getDiagnosticFlags?.(this.agent) ?? ""}`,
    );
    homeAssistant.callAction(action);
  }

  private handleLiftClose() {
    clearPendingLift(getCoverDebounce(this.endpoint));

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.closeCoverLift(void 0, this.agent);
    const end = haRestEnd(action);
    const atRest = this.isAtExpectedRest("lift", end);

    // Matter close intent = moving towards 10000 = Closing (swap-independent).
    if (atRest) {
      this.settleAtRest("lift");
    } else {
      this.startOptimisticMovement("lift", MovementStatus.Closing, end);
    }

    logger.info(
      `handleLiftClose ${homeAssistant.entityId}: calling action=${action.action}, atRest=${atRest}, ${this.state.config.getDiagnosticFlags?.(this.agent) ?? ""}`,
    );
    homeAssistant.callAction(action);
  }

  private handleGoToLiftPosition(targetPercent100ths: number) {
    const config = this.state.config;
    // Compare in Matter space (both values should be in same coordinate system)
    const currentPositionMatter = this.state.currentPositionLiftPercent100ths;
    // Skip only a target the axis is already at. Strict on purpose: the
    // completion check tolerates one percent, this must not, or a one percent
    // slider step is dropped instead of dispatched (#429).
    if (
      currentPositionMatter != null &&
      isExactPosition(targetPercent100ths, currentPositionMatter)
    ) {
      return;
    }
    // Update target immediately for UI feedback
    this.state.targetPositionLiftPercent100ths = targetPercent100ths;
    // Capture EVERYTHING needed for the debounced callback NOW while context is valid
    // The agent context expires after the command handler returns, so we must not
    // access any behavior properties (including entityId) inside setTimeout
    const targetPosition = targetPercent100ths / 100;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = config.setLiftPosition(targetPosition, this.agent);
    const entityId = homeAssistant.entityId;
    // Direction in the controller's own numeric space: it compares the target it
    // sent against the current position it sees. Higher 100ths = more closed, so
    // target above current = Closing. This stays self-consistent even under
    // coverUseHomeAssistantPercentage because both numbers live in the same stored
    // attribute space the controller reads, which is what clears its label (#429).
    // set_cover_position lands on the target, so the expectation stays null there
    // and only a binary cover (open/close instead of a position) records one.
    this.startOptimisticMovement(
      "lift",
      currentPositionMatter != null &&
        targetPercent100ths < currentPositionMatter
        ? MovementStatus.Opening
        : MovementStatus.Closing,
      haRestEnd(action),
    );
    const actions = this.env.get(HomeAssistantActions);
    const st = getCoverDebounce(this.endpoint);
    st.pendingLift = { action, entityId, actions };

    // Two-phase debounce for GH quick swipes; coverSliderDebounceMs collapses
    // both phases into one window for controllers that stream slider updates.
    const now = Date.now();
    const timeSinceLastCommand = now - st.lastLiftCommandTime;
    st.lastLiftCommandTime = now;

    const isFirstInSequence =
      timeSinceLastCommand >
      WindowCoveringServerBase.COMMAND_SEQUENCE_THRESHOLD_MS;
    const overrideMs = this.resolveDebounceOverride(homeAssistant);
    const debounceMs =
      overrideMs != null
        ? overrideMs
        : isFirstInSequence
          ? WindowCoveringServerBase.DEBOUNCE_INITIAL_MS
          : WindowCoveringServerBase.DEBOUNCE_SUBSEQUENT_MS;

    logger.debug(
      `Lift command: target=${targetPosition}%, debounce=${debounceMs}ms (${overrideMs != null ? "override" : isFirstInSequence ? "initial" : "subsequent"})`,
    );

    // The registry lives on the persistent endpoint, so this clears the
    // previous command's live timer and only the last pending action fires.
    if (st.liftTimer) {
      clearTimeout(st.liftTimer);
    }
    st.liftTimer = setTimeout(() => {
      st.liftTimer = null;
      if (st.pendingLift) {
        const {
          action: pendingAction,
          entityId: eid,
          actions: act,
        } = st.pendingLift;
        st.pendingLift = null;
        act.call(pendingAction, eid);
      }
    }, debounceMs);
  }

  private handleTiltOpen() {
    const st = getCoverDebounce(this.endpoint);
    clearPendingTilt(st);
    // tilt-only covers park tilt actions in the lift slot, #350
    if (st.pendingLift?.action.action.includes("tilt")) clearPendingLift(st);

    const action = this.state.config.openCoverTilt(void 0, this.agent);
    const end = haRestEnd(action);
    const atRest = this.isAtExpectedRest("tilt", end);
    if (atRest) {
      this.settleAtRest("tilt");
    } else {
      this.startOptimisticMovement("tilt", MovementStatus.Opening, end);
    }

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    logger.info(
      `handleTiltOpen ${homeAssistant.entityId}: calling action=${action.action}, atRest=${atRest}, ${this.state.config.getDiagnosticFlags?.(this.agent) ?? ""}`,
    );
    homeAssistant.callAction(action);
  }

  private handleTiltClose() {
    const st = getCoverDebounce(this.endpoint);
    clearPendingTilt(st);
    // tilt-only covers park tilt actions in the lift slot, #350
    if (st.pendingLift?.action.action.includes("tilt")) clearPendingLift(st);

    const action = this.state.config.closeCoverTilt(void 0, this.agent);
    const end = haRestEnd(action);
    const atRest = this.isAtExpectedRest("tilt", end);
    if (atRest) {
      this.settleAtRest("tilt");
    } else {
      this.startOptimisticMovement("tilt", MovementStatus.Closing, end);
    }

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    logger.info(
      `handleTiltClose ${homeAssistant.entityId}: calling action=${action.action}, atRest=${atRest}, ${this.state.config.getDiagnosticFlags?.(this.agent) ?? ""}`,
    );
    homeAssistant.callAction(action);
  }

  private handleGoToTiltPosition(targetPercent100ths: number) {
    const config = this.state.config;
    // Compare in Matter space (both values should be in same coordinate system)
    const currentPositionMatter = this.state.currentPositionTiltPercent100ths;
    // Strict, same reason as lift: one percent is a real move (#429).
    if (
      currentPositionMatter != null &&
      isExactPosition(targetPercent100ths, currentPositionMatter)
    ) {
      return;
    }
    // Update target immediately for UI feedback
    this.state.targetPositionTiltPercent100ths = targetPercent100ths;
    // Capture EVERYTHING needed for the debounced callback NOW while context is valid
    // The agent context expires after the command handler returns, so we must not
    // access any behavior properties (including entityId) inside setTimeout
    const targetPosition = targetPercent100ths / 100;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = config.setTiltPosition(targetPosition, this.agent);
    const entityId = homeAssistant.entityId;
    // Same controller-space direction derivation and rest expectation as lift (#429).
    this.startOptimisticMovement(
      "tilt",
      currentPositionMatter != null &&
        targetPercent100ths < currentPositionMatter
        ? MovementStatus.Opening
        : MovementStatus.Closing,
      haRestEnd(action),
    );
    const actions = this.env.get(HomeAssistantActions);
    const st = getCoverDebounce(this.endpoint);
    st.pendingTilt = { action, entityId, actions };

    // Same two-phase / override logic as lift.
    const now = Date.now();
    const timeSinceLastCommand = now - st.lastTiltCommandTime;
    st.lastTiltCommandTime = now;

    const isFirstInSequence =
      timeSinceLastCommand >
      WindowCoveringServerBase.COMMAND_SEQUENCE_THRESHOLD_MS;
    const overrideMs = this.resolveDebounceOverride(homeAssistant);
    const debounceMs =
      overrideMs != null
        ? overrideMs
        : isFirstInSequence
          ? WindowCoveringServerBase.DEBOUNCE_INITIAL_MS
          : WindowCoveringServerBase.DEBOUNCE_SUBSEQUENT_MS;

    logger.debug(
      `Tilt command: target=${targetPosition}%, debounce=${debounceMs}ms (${overrideMs != null ? "override" : isFirstInSequence ? "initial" : "subsequent"})`,
    );

    // Registry-held timer, so a later tilt command cancels this one's pending
    // action instead of both firing.
    if (st.tiltTimer) {
      clearTimeout(st.tiltTimer);
    }
    st.tiltTimer = setTimeout(() => {
      st.tiltTimer = null;
      if (st.pendingTilt) {
        const {
          action: pendingAction,
          entityId: eid,
          actions: act,
        } = st.pendingTilt;
        st.pendingTilt = null;
        act.call(pendingAction, eid);
      }
    }, debounceMs);
  }
}

export namespace WindowCoveringServerBase {
  export class State extends FeaturedBase.State {
    config!: WindowCoveringConfig;
  }
}

export function WindowCoveringServer(config: WindowCoveringConfig) {
  return WindowCoveringServerBase.set({ config });
}
