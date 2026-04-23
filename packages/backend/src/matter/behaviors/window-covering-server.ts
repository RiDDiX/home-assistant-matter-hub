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
  "AbsolutePosition",
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

export class WindowCoveringServerBase extends FeaturedBase {
  declare state: WindowCoveringServerBase.State;

  private liftDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private tiltDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Track when the last command was received to implement two-phase debounce
  private lastLiftCommandTime = 0;
  private lastTiltCommandTime = 0;
  // Track lift direction to skip redundant tilt on downOrClose / upOrOpen (#246)
  private lastLiftMovementMs = 0;
  private lastLiftMovementDirection: MovementDirection | null = null;
  // Store everything needed for debounced HA calls - entityId and actions service
  // must be captured before setTimeout because agent context expires after command handler
  private pendingLiftAction: {
    action: HomeAssistantAction;
    entityId: string;
    actions: HomeAssistantActions;
  } | null = null;
  private pendingTiltAction: {
    action: HomeAssistantAction;
    entityId: string;
    actions: HomeAssistantActions;
  } | null = null;
  // Two-phase debounce: longer for first command (quick swipe sends initial step value),
  // shorter for subsequent commands during drag
  private static readonly DEBOUNCE_INITIAL_MS = 400;
  private static readonly DEBOUNCE_SUBSEQUENT_MS = 150;
  private static readonly COMMAND_SEQUENCE_THRESHOLD_MS = 600;

  override async [Symbol.asyncDispose]() {
    if (this.liftDebounceTimer) {
      clearTimeout(this.liftDebounceTimer);
      this.liftDebounceTimer = null;
    }
    if (this.tiltDebounceTimer) {
      clearTimeout(this.tiltDebounceTimer);
      this.tiltDebounceTimer = null;
    }
    this.pendingLiftAction = null;
    this.pendingTiltAction = null;
    await super[Symbol.asyncDispose]();
  }

  override async initialize() {
    // Set default values BEFORE super.initialize() to prevent validation errors.
    // WindowCovering with PositionAware features requires valid position values.
    if (this.features.lift) {
      if (this.state.installedOpenLimitLift == null) {
        this.state.installedOpenLimitLift = 0;
      }
      if (this.state.installedClosedLimitLift == null) {
        this.state.installedClosedLimitLift = 10000; // 100.00%
      }
    }
    if (this.features.tilt) {
      if (this.state.installedOpenLimitTilt == null) {
        this.state.installedOpenLimitTilt = 0;
      }
      if (this.state.installedClosedLimitTilt == null) {
        this.state.installedClosedLimitTilt = 10000; // 100.00%
      }
    }
    if (this.features.positionAwareLift) {
      if (this.state.currentPositionLiftPercent100ths === undefined) {
        this.state.currentPositionLiftPercent100ths = null;
      }
      if (this.state.targetPositionLiftPercent100ths === undefined) {
        this.state.targetPositionLiftPercent100ths = null;
      }
    }
    if (this.features.positionAwareTilt) {
      if (this.state.currentPositionTiltPercent100ths === undefined) {
        this.state.currentPositionTiltPercent100ths = null;
      }
      if (this.state.targetPositionTiltPercent100ths === undefined) {
        this.state.targetPositionTiltPercent100ths = null;
      }
    }

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
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
        operationalStatus: {
          global: movementStatus,
          ...(this.features.lift ? { lift: movementStatus } : {}),
          ...(this.features.tilt ? { tilt: movementStatus } : {}),
        },
        ...(this.features.absolutePosition && this.features.lift
          ? {
              installedOpenLimitLift: 0,
              installedClosedLimitLift: 100_00,
              currentPositionLift: currentLift100ths,
            }
          : {}),
        ...(this.features.absolutePosition && this.features.tilt
          ? {
              installedOpenLimitTilt: 0,
              installedClosedLimitTilt: 100_00,
              currentPositionTilt: currentTilt100ths,
            }
          : {}),
        ...(this.features.positionAwareLift
          ? {
              currentPositionLiftPercentage: currentLift,
              currentPositionLiftPercent100ths: currentLift100ths,
              targetPositionLiftPercent100ths: inferTarget(
                currentLift100ths,
                this.state.targetPositionLiftPercent100ths,
              ),
            }
          : {}),
        ...(this.features.positionAwareTilt
          ? {
              currentPositionTiltPercentage: currentTilt,
              currentPositionTiltPercent100ths: currentTilt100ths,
              targetPositionTiltPercent100ths: inferTarget(
                currentTilt100ths,
                this.state.targetPositionTiltPercent100ths,
              ),
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
      `handleMovement: type=${MovementType[type]}, direction=${MovementDirection[direction]}, target=${targetPercent100ths}, currentLift=${currentLift}, currentTilt=${currentTilt}, absolutePosition=${this.features.absolutePosition}`,
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
        this.features.absolutePosition
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
          `Skipping tilt ${MovementDirection[direction]} — lift already moving in same direction`,
        );
        return;
      }
      if (targetPercent100ths === 0) {
        this.handleTiltOpen();
      } else if (targetPercent100ths === 10000) {
        this.handleTiltClose();
      } else if (
        targetPercent100ths != null &&
        this.features.absolutePosition
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
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(this.state.config.stopCover(void 0, this.agent));
  }

  private handleLiftOpen() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.openCoverLift(void 0, this.agent);
    logger.info(`handleLiftOpen: calling action=${action.action}`);
    homeAssistant.callAction(action);
  }

  private handleLiftClose() {
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
    this.pendingLiftAction = { action, entityId, actions };

    // Two-phase debounce to handle Google Home's quick swipe behavior:
    // - Quick swipe sends an initial "step" value, then final value after a delay
    // - If we use short debounce, the step value gets executed before final arrives
    // - Use longer debounce for first command, shorter for subsequent commands in sequence
    const now = Date.now();
    const timeSinceLastCommand = now - this.lastLiftCommandTime;
    this.lastLiftCommandTime = now;

    const isFirstInSequence =
      timeSinceLastCommand >
      WindowCoveringServerBase.COMMAND_SEQUENCE_THRESHOLD_MS;
    const debounceMs = isFirstInSequence
      ? WindowCoveringServerBase.DEBOUNCE_INITIAL_MS
      : WindowCoveringServerBase.DEBOUNCE_SUBSEQUENT_MS;

    logger.debug(
      `Lift command: target=${targetPosition}%, debounce=${debounceMs}ms (${isFirstInSequence ? "initial" : "subsequent"})`,
    );

    if (this.liftDebounceTimer) {
      clearTimeout(this.liftDebounceTimer);
    }
    this.liftDebounceTimer = setTimeout(() => {
      this.liftDebounceTimer = null;
      if (this.pendingLiftAction) {
        const {
          action: pendingAction,
          entityId: eid,
          actions: act,
        } = this.pendingLiftAction;
        this.pendingLiftAction = null;
        act.call(pendingAction, eid);
      }
    }, debounceMs);
  }

  private handleTiltOpen() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(
      this.state.config.openCoverTilt(void 0, this.agent),
    );
  }

  private handleTiltClose() {
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
    this.pendingTiltAction = { action, entityId, actions };

    // Two-phase debounce (same logic as lift)
    const now = Date.now();
    const timeSinceLastCommand = now - this.lastTiltCommandTime;
    this.lastTiltCommandTime = now;

    const isFirstInSequence =
      timeSinceLastCommand >
      WindowCoveringServerBase.COMMAND_SEQUENCE_THRESHOLD_MS;
    const debounceMs = isFirstInSequence
      ? WindowCoveringServerBase.DEBOUNCE_INITIAL_MS
      : WindowCoveringServerBase.DEBOUNCE_SUBSEQUENT_MS;

    logger.debug(
      `Tilt command: target=${targetPosition}%, debounce=${debounceMs}ms (${isFirstInSequence ? "initial" : "subsequent"})`,
    );

    if (this.tiltDebounceTimer) {
      clearTimeout(this.tiltDebounceTimer);
    }
    this.tiltDebounceTimer = setTimeout(() => {
      this.tiltDebounceTimer = null;
      if (this.pendingTiltAction) {
        const {
          action: pendingAction,
          entityId: eid,
          actions: act,
        } = this.pendingTiltAction;
        this.pendingTiltAction = null;
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
