import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
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

    // When cover is stopped, target position MUST equal current position.
    // This is critical for Matter controllers to correctly display the cover state.
    // Without this, Google Home and other controllers may show stale positions.
    const isStopped = movementStatus === MovementStatus.Stopped;

    // When movement is initiated externally (HA / physical button), no Matter
    // command sets targetPosition. The stale target (equal to the previous
    // stopped position) misleads Apple Home which derives the displayed
    // direction from current-vs-target, not only from operationalStatus.
    // Fix: if the existing target doesn't agree with the movement direction,
    // override it with the direction limit (#268).
    const inferTarget = (
      current100ths: number | null,
      existing100ths: number | null | undefined,
    ): number | null => {
      if (isStopped) return current100ths;
      if (movementStatus === MovementStatus.Opening) {
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
      if (movementStatus === MovementStatus.Closing) {
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
      `Cover update for ${entity.entity_id}: state=${state.state}, lift=${currentLift}%, tilt=${currentTilt}%, movement=${MovementStatus[movementStatus]}`,
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
      !isStopped && previousStatus === MovementStatus.Stopped;

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
                currentLift100ths,
                this.state.targetPositionLiftPercent100ths,
              ),
            }
          : {}),
        ...(this.features.positionAwareTilt
          ? {
              targetPositionTiltPercent100ths: inferTarget(
                currentTilt100ths,
                this.state.targetPositionTiltPercent100ths,
              ),
            }
          : {}),
        operationalStatus: {
          global: movementStatus,
          ...(this.features.lift ? { lift: movementStatus } : {}),
          ...(this.features.tilt ? { tilt: movementStatus } : {}),
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

  override async handleMovement(
    type: MovementType,
    _: boolean,
    direction: MovementDirection,
    targetPercent100ths?: number,
  ) {
    const currentLift = this.state.currentPositionLiftPercent100ths ?? 0;
    const currentTilt = this.state.currentPositionTiltPercent100ths ?? 0;

    logger.info(
      `handleMovement: type=${MovementType[type]}, direction=${MovementDirection[direction]}, target=${targetPercent100ths}, currentLift=${currentLift}, currentTilt=${currentTilt}`,
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

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(this.state.config.stopCover(void 0, this.agent));
  }

  private handleLiftOpen() {
    clearPendingLift(getCoverDebounce(this.endpoint));

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.openCoverLift(void 0, this.agent);
    logger.info(`handleLiftOpen: calling action=${action.action}`);
    homeAssistant.callAction(action);
  }

  private handleLiftClose() {
    clearPendingLift(getCoverDebounce(this.endpoint));

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.closeCoverLift(void 0, this.agent);
    logger.info(`handleLiftClose: calling action=${action.action}`);
    homeAssistant.callAction(action);
  }

  private handleGoToLiftPosition(targetPercent100ths: number) {
    const config = this.state.config;
    // Compare in Matter space (both values should be in same coordinate system)
    const currentPositionMatter = this.state.currentPositionLiftPercent100ths;
    // Skip if already at target (with small tolerance for rounding)
    if (
      currentPositionMatter != null &&
      Math.abs(targetPercent100ths - currentPositionMatter) < 100
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

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(
      this.state.config.openCoverTilt(void 0, this.agent),
    );
  }

  private handleTiltClose() {
    const st = getCoverDebounce(this.endpoint);
    clearPendingTilt(st);
    // tilt-only covers park tilt actions in the lift slot, #350
    if (st.pendingLift?.action.action.includes("tilt")) clearPendingLift(st);

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(
      this.state.config.closeCoverTilt(void 0, this.agent),
    );
  }

  private handleGoToTiltPosition(targetPercent100ths: number) {
    const config = this.state.config;
    // Compare in Matter space (both values should be in same coordinate system)
    const currentPositionMatter = this.state.currentPositionTiltPercent100ths;
    // Skip if already at target (with small tolerance for rounding)
    if (
      currentPositionMatter != null &&
      Math.abs(targetPercent100ths - currentPositionMatter) < 100
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
