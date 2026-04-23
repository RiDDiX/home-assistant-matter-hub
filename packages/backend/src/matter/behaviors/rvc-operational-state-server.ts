import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { RvcOperationalStateServer as Base } from "@matter/main/behaviors/rvc-operational-state";
import { RvcOperationalState } from "@matter/main/clusters/rvc-operational-state";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import OperationalState = RvcOperationalState.OperationalState;
import ErrorState = RvcOperationalState.ErrorState;

const logger = Logger.get("RvcOperationalStateServer");

// States that indicate the vacuum is actively performing work
const activeStates = new Set([
  OperationalState.Running,
  OperationalState.SeekingCharger,
]);

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

export interface RvcOperationalStateServerConfig {
  getOperationalState: ValueGetter<OperationalState>;
  pause: ValueSetter<void>;
  resume: ValueSetter<void>;
  goHome?: ValueSetter<void>;
}

// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class RvcOperationalStateServerBase extends Base {
  declare state: RvcOperationalStateServerBase.State;

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
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const newState = this.state.config.getOperationalState(
      entity.state,
      this.agent,
    );
    const previousState = this.state.operationalState;

    const errorStateId =
      newState === OperationalState.Error
        ? ErrorState.Stuck
        : ErrorState.NoError;
    // Force a structural difference on every call so matter.js Datasource
    // never deep-equals this away. A unique errorStateDetails string
    // guarantees the struct differs from its predecessor, producing a
    // subscription report even during steady-state (same operationalState).
    //
    // Why not a toggling boolean/nonce? matter.js behavior reactors run on
    // transient proxy instances — private instance properties reset to their
    // initial value on every invocation, so a toggle never actually flips.
    const operationalError = {
      errorStateId,
      errorStateDetails: String(Date.now()),
    };

    applyPatchState(
      this.state,
      {
        operationalState: newState,
        operationalError,
      },
      { force: true },
    );

    // Emit OperationCompletion event when transitioning from an active state
    // (Running, SeekingCharger) to an inactive state (Docked, Stopped, Paused).
    // This is MANDATORY for the RoboticVacuumCleaner device type.
    if (
      activeStates.has(previousState as OperationalState) &&
      !activeStates.has(newState)
    ) {
      logger.info(
        `Operation completed: ${OperationalState[previousState]} -> ${OperationalState[newState]}`,
      );
      try {
        this.events.operationCompletion?.emit(
          {
            completionErrorCode:
              newState === OperationalState.Error
                ? ErrorState.Stuck
                : ErrorState.NoError,
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
    homeAssistant.callAction(this.state.config.resume(void 0, this.agent));
    return {
      commandResponseState: {
        errorStateId: ErrorState.NoError,
      },
    };
  }

  override goHome(): RvcOperationalState.OperationalCommandResponse {
    // Already docked or charging - command is valid but no-op
    if (
      this.state.operationalState === OperationalState.Docked ||
      this.state.operationalState === OperationalState.Charging
    ) {
      return {
        commandResponseState: {
          errorStateId: ErrorState.NoError,
        },
      };
    }

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
  export class State extends Base.State {
    config!: RvcOperationalStateServerConfig;
  }
}

export function RvcOperationalStateServer(
  config: RvcOperationalStateServerConfig,
) {
  return RvcOperationalStateServerBase.set({ config });
}
