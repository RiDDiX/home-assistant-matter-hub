import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger, Millis, Seconds, Time, type Timer } from "@matter/general";
import { RvcOperationalStateServer as Base } from "@matter/main/behaviors/rvc-operational-state";
import { RvcOperationalState } from "@matter/main/clusters/rvc-operational-state";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { trimToLength } from "../../utils/trim-to-length.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import { endCleaningSession } from "./rvc-run-mode-server.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import OperationalState = RvcOperationalState.OperationalState;
import ErrorState = RvcOperationalState.ErrorState;

const logger = Logger.get("RvcOperationalStateServer");

// States still in progress. A paused job counts.
const activeStates = new Set([
  OperationalState.Running,
  OperationalState.SeekingCharger,
  OperationalState.Paused,
]);

// Last state Home Assistant reported, per endpoint. A controller start shows
// Running before HA confirms it (#496), that is no finished job.
const haStates = new WeakMap<object, OperationalState>();
const errorTimers = new WeakMap<object, Timer>();

// Operational states to advertise in operationalStateList.
// Only include the well-established states from the base OperationalState
// cluster (0-3) and the core RVC-specific states (64-66).
// Matter 1.4 added new states (EmptyingDustBin=67, CleaningMop=68,
// FillingWaterTank=69, UpdatingMaps=70) but controllers like Alexa
// (Matter 1.3) may not handle them and could reject the device.
const advertisedOperationalStates: number[] = [
  OperationalState.Stopped,
  OperationalState.Running,
  OperationalState.Paused,
  OperationalState.Error,
  OperationalState.SeekingCharger,
  OperationalState.Charging,
  OperationalState.Docked,
];

export function makeRvcOperationalError(
  errorStateId: ErrorState,
): RvcOperationalState.ErrorStateStruct {
  if (errorStateId === ErrorState.NoError) {
    return { errorStateId };
  }
  return { errorStateId, errorStateDetails: ErrorState[errorStateId] };
}

export interface RvcOperationalStateServerConfig {
  getOperationalState: ValueGetter<OperationalState>;
  getOperationalError?: ValueGetter<RvcOperationalState.ErrorStateStruct>;
  getOperationalErrorSettleMs?: ValueGetter<number>;
  getOperationCompletionError?: ValueGetter<ErrorState>;
  getAdditionalOperationalStates?: ValueGetter<number[]>;
  getRecheckAfterMs?: ValueGetter<number | undefined>;
  getResumeError?: ValueGetter<string | undefined>;
  // Docked or charging underneath an UpdatingMaps/Error status overlay
  isAtBase?: ValueGetter<boolean>;
  pause: ValueSetter<void>;
  resume: ValueSetter<void>;
  goHome?: ValueSetter<void>;
  getPhase?: ValueGetter<
    { phaseList: string[] | null; currentPhase: number | null } | undefined
  >;
  shouldCompleteOperation?: ValueGetter<boolean | undefined>;
}

// OperationCompletion is optional in the cluster, so matter.js leaves it off
// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class RvcOperationalStateServerBase extends Base.enable({
  events: { operationCompletion: true },
}) {
  declare state: RvcOperationalStateServerBase.State;
  declare internal: RvcOperationalStateServerBase.Internal;

  override async initialize() {
    // Set initial operationalStateList BEFORE super.initialize().
    // Use the explicit list of well-known states to avoid advertising
    // Matter 1.4 states that older controllers may not understand.
    this.state.operationalStateList = advertisedOperationalStates.map((id) => ({
      operationalStateId: id,
    }));
    this.state.operationalState = OperationalState.Stopped;
    this.state.operationalError = { errorStateId: ErrorState.NoError };

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);

    this.update(homeAssistant.entity);
    // offline: true makes the reactor run in its own LocalActorContext
    // with a fresh transaction, instead of the parent's postCommit phase.
    // Without this, reactor writes are buffered but never produce
    // subscription reports (the parent transaction has already finalized),
    // so controllers like Apple Home never see state transitions.
    this.reactTo(homeAssistant.onChange, this.update, {
      offline: true,
      lock: true,
    });
  }

  private update(entity: HomeAssistantEntityInformation) {
    this.applyEntityState(entity, false);
  }

  private flushPendingError() {
    errorTimers.delete(this.endpoint);
    this.applyEntityState(
      this.agent.get(HomeAssistantEntityBehavior).entity,
      true,
    );
  }

  override async [Symbol.asyncDispose]() {
    errorTimers.get(this.endpoint)?.stop();
    errorTimers.delete(this.endpoint);
    haStates.delete(this.endpoint);
    this.internal.recheck?.stop();
    await super[Symbol.asyncDispose]();
  }

  private applyEntityState(
    entity: HomeAssistantEntityInformation,
    errorSettled: boolean,
  ) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    // Also handle a readiness mapping added/removed after initialization.
    // Only this attribute changes; endpoint identity and clusters stay intact.
    const extra =
      this.state.config.getAdditionalOperationalStates?.(
        entity.state,
        this.agent,
      ) ?? [];
    applyPatchState(this.state, {
      operationalStateList: [
        ...new Set([...advertisedOperationalStates, ...extra]),
      ].map((id) => ({ operationalStateId: id })),
    });

    // A stable-ready delay must expire even if HA sends no more state changes.
    // One timer, inside a fresh locked transaction; no polling or HA actions.
    // Read before the state getters: if the hold expires between these reads,
    // the timer still fires and re-evaluates.
    this.internal.recheck?.stop();
    const delay = this.state.config.getRecheckAfterMs?.(
      entity.state,
      this.agent,
    );
    if (delay !== undefined && delay > 0) {
      this.internal.recheckCallback ??= this.callback(this.recheck, {
        offline: true,
        lock: true,
      });
      this.internal.recheck = Time.getTimer(
        "vacuum-readiness",
        Millis(Math.max(1, Math.ceil(delay))),
        this.internal.recheckCallback,
      ).start();
    }

    const newState = this.state.config.getOperationalState(
      entity.state,
      this.agent,
    );
    const previousState = haStates.get(this.endpoint);
    const settleMs =
      this.state.config.getOperationalErrorSettleMs?.(
        entity.state,
        this.agent,
      ) ?? 0;
    if (
      newState === OperationalState.Error &&
      previousState !== undefined &&
      previousState !== OperationalState.Error &&
      settleMs > 0 &&
      !errorSettled
    ) {
      if (!errorTimers.has(this.endpoint)) {
        errorTimers.set(
          this.endpoint,
          this.reactorTimer(
            "operational-error-settle",
            Seconds(settleMs / 1000),
            this.flushPendingError,
            { offline: true, lock: true },
          ).start(),
        );
      }
      return;
    }
    errorTimers.get(this.endpoint)?.stop();
    errorTimers.delete(this.endpoint);
    haStates.set(this.endpoint, newState);

    const errorStateId =
      newState === OperationalState.Error
        ? ErrorState.Stuck
        : ErrorState.NoError;
    const operationalError =
      this.state.config.getOperationalError?.(entity.state, this.agent) ??
      makeRvcOperationalError(errorStateId);

    applyPatchState(
      this.state,
      {
        ...(this.state.config.getPhase?.(entity.state, this.agent) ?? {}),
        operationalState: newState,
        operationalError,
      },
      { force: true },
    );

    // Emit OperationCompletion event when transitioning from an active state
    // (Running, SeekingCharger, Paused) to Docked, Stopped or Error.
    // Required on the RoboticVacuumCleaner device type.
    // An unavailable or unknown device has no confirmed finished job.
    const offline =
      entity.state.state === "unavailable" || entity.state.state === "unknown";
    const complete =
      this.state.config.shouldCompleteOperation?.(entity.state, this.agent) ??
      (previousState !== undefined &&
        activeStates.has(previousState) &&
        !activeStates.has(newState));
    if (!offline && previousState !== undefined && complete) {
      logger.info(
        `Operation completed: ${previousState === undefined ? "initial" : OperationalState[previousState]} -> ${OperationalState[newState]}`,
      );
      try {
        this.events.operationCompletion?.emit(
          {
            completionErrorCode:
              this.state.config.getOperationCompletionError?.(
                entity.state,
                this.agent,
              ) ??
              (newState === OperationalState.Error
                ? operationalError.errorStateId
                : ErrorState.NoError),
            totalOperationalTime: null,
            pausedTime: null,
          },
          this.context,
        );
      } catch (e) {
        logger.debug("Failed to emit operationCompletion event:", e);
      }
    }
  }

  private recheck() {
    this.update(this.agent.get(HomeAssistantEntityBehavior).entity);
  }

  override pause(): RvcOperationalState.OperationalCommandResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(this.state.config.pause(void 0, this.agent));
    return {
      commandResponseState: {
        errorStateId: ErrorState.NoError,
      },
    };
  }

  override resume(): RvcOperationalState.OperationalCommandResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const reason = this.state.config.getResumeError?.(
      homeAssistant.entity.state,
      this.agent,
    );
    if (reason) {
      return {
        commandResponseState: {
          errorStateId: ErrorState.UnableToStartOrResume,
          errorStateDetails: trimToLength(reason, 64, "..."),
        },
      };
    }
    homeAssistant.callAction(this.state.config.resume(void 0, this.agent));
    return {
      commandResponseState: {
        errorStateId: ErrorState.NoError,
      },
    };
  }

  override goHome(): RvcOperationalState.OperationalCommandResponse {
    // Already docked or charging - command is valid but no-op. A job paused
    // at the dock for a recharge reports Paused while HA says docked.
    const current = this.state.operationalState;
    const haState = this.agent.get(HomeAssistantEntityBehavior).entity.state;
    if (
      current === OperationalState.Docked ||
      current === OperationalState.Charging ||
      haState.state === "docked" ||
      ((current === OperationalState.UpdatingMaps ||
        current === OperationalState.Error) &&
        this.state.config.isAtBase?.(haState, this.agent))
    ) {
      return {
        commandResponseState: {
          errorStateId: ErrorState.NoError,
        },
      };
    }

    // Else docking reads as a between-rooms gap and fires the next room
    endCleaningSession(this.agent);
    const goHomeAction = this.state.config.goHome;
    if (goHomeAction) {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      homeAssistant.callAction(goHomeAction(void 0, this.agent));
    } else {
      logger.warn("GoHome command received but no goHome action configured");
    }

    return {
      commandResponseState: {
        errorStateId: ErrorState.NoError,
      },
    };
  }
}

namespace RvcOperationalStateServerBase {
  export class Internal extends Base.Internal {
    recheck?: Timer;
    recheckCallback?: Timer.Callback;
  }
  export class State extends Base.State {
    config!: RvcOperationalStateServerConfig;
  }
}

export function RvcOperationalStateServer(
  config: RvcOperationalStateServerConfig,
) {
  return RvcOperationalStateServerBase.set({ config });
}
