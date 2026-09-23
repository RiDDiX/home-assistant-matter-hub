import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { OperationalStateServer as Base } from "@matter/main/behaviors/operational-state";
import { OperationalState } from "@matter/main/clusters/operational-state";
import {
  DishwasherDevice,
  LaundryDryerDevice,
  LaundryWasherDevice,
} from "@matter/main/devices";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { applyPatchState } from "../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

const Op = OperationalState.OperationalStateEnum;

// HA states and what Home Connect, SmartThings, Miele and LG report (#486).
const haStateToOperationalState: Record<
  string,
  OperationalState.OperationalStateEnum
> = {
  off: Op.Stopped,
  idle: Op.Stopped,
  standby: Op.Stopped,
  on: Op.Running,
  running: Op.Running,
  active: Op.Running,
  drying: Op.Running,
  washing: Op.Running,
  paused: Op.Paused,
  complete: Op.Stopped,
  finished: Op.Stopped,
  inactive: Op.Stopped,
  ready: Op.Stopped,
  delayedstart: Op.Stopped,
  run: Op.Running,
  pause: Op.Paused,
  // waiting for the user
  actionrequired: Op.Paused,
  aborting: Op.Running,
  error: Op.Error,
  stop: Op.Stopped,
  // Miele
  in_use: Op.Running,
  programmed: Op.Stopped,
  waiting_to_start: Op.Stopped,
  program_ended: Op.Stopped,
  program_interrupted: Op.Stopped,
  rinse_hold: Op.Paused,
  failure: Op.Error,
  // LG ThinQ
  detecting: Op.Running,
  prewash: Op.Running,
  soaking: Op.Running,
  add_drain: Op.Running,
  dispensing: Op.Running,
  rinsing: Op.Running,
  softening: Op.Running,
  steam_softening: Op.Running,
  spinning: Op.Running,
  refreshing: Op.Running,
  cooling: Op.Running,
  cool_down: Op.Running,
  night_dry: Op.Running,
  end: Op.Stopped,
  running_end: Op.Stopped,
  done: Op.Stopped,
  initial: Op.Stopped,
  power_off: Op.Stopped,
  reserved: Op.Stopped,
  power_fail: Op.Error,
};

const cycleStates = new Set([Op.Running, Op.Paused]);

// OperationCompletion is optional in the cluster, so matter.js leaves it off
class ApplianceOperationalStateServer extends Base.enable({
  events: { operationCompletion: true },
}) {
  override async initialize() {
    this.state.operationalStateList = [
      { operationalStateId: Op.Stopped },
      { operationalStateId: Op.Running },
      { operationalStateId: Op.Paused },
      { operationalStateId: Op.Error },
    ];
    this.state.operationalState = Op.Stopped;
    this.state.operationalError = {
      errorStateId: OperationalState.ErrorState.NoError,
    };

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { lock: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state) {
      return;
    }
    const stateEntity = this.agent.get(HomeAssistantEntityBehavior).state
      .mapping?.operationalStateEntity;
    const raw = stateEntity
      ? this.agent.env.get(EntityStateProvider).getState(stateEntity)?.state
      : entity.state.state;
    // a cloud blip mid-cycle must not end the cycle
    if (raw === "unavailable" || raw === "unknown") {
      return;
    }
    let haState = raw?.toLowerCase() ?? "off";
    // Miele's status sensor says "on" when the machine is on but idle
    if (stateEntity && haState === "on") {
      haState = "idle";
    }
    const mapped = haStateToOperationalState[haState];
    // a sensor state we don't know (Miele not_connected, a gone sensor) keeps
    // the last state
    if (stateEntity && (raw === undefined || mapped === undefined)) {
      return;
    }
    const newState = mapped ?? Op.Stopped;
    const previous = this.state.operationalState;
    const errorStateId =
      newState === Op.Error
        ? OperationalState.ErrorState.UnableToCompleteOperation
        : OperationalState.ErrorState.NoError;
    applyPatchState(this.state, {
      operationalState: newState,
      operationalError: { errorStateId },
    });
    // required on all three types, so the controller sees the cycle end
    if (cycleStates.has(previous) && !cycleStates.has(newState)) {
      this.events.operationCompletion.emit(
        {
          completionErrorCode: errorStateId,
          totalOperationalTime: null,
          pausedTime: null,
        },
        this.context,
      );
    }
  }

  override pause(): OperationalState.OperationalCommandResponse {
    return {
      commandResponseState: {
        errorStateId: OperationalState.ErrorState.CommandInvalidInState,
      },
    };
  }

  override stop(): OperationalState.OperationalCommandResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction({ action: "homeassistant.turn_off" });
    return {
      commandResponseState: {
        errorStateId: OperationalState.ErrorState.NoError,
      },
    };
  }

  override start(): OperationalState.OperationalCommandResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction({ action: "homeassistant.turn_on" });
    return {
      commandResponseState: {
        errorStateId: OperationalState.ErrorState.NoError,
      },
    };
  }

  override resume(): OperationalState.OperationalCommandResponse {
    return this.start();
  }
}

// Spec requires DeadFrontBehavior when these types include OnOff.
const ApplianceOnOffServer = OnOffServer({
  turnOn: () => ({
    action: "homeassistant.turn_on",
  }),
  turnOff: () => ({
    action: "homeassistant.turn_off",
  }),
}).with("DeadFrontBehavior");

const behaviors = [
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  ApplianceOperationalStateServer,
  ApplianceOnOffServer,
] as const;

const DishwasherType = DishwasherDevice.with(...behaviors);
const LaundryWasherType = LaundryWasherDevice.with(...behaviors);
const LaundryDryerType = LaundryDryerDevice.with(...behaviors);

export function DishwasherEndpoint(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return DishwasherType.set({ homeAssistantEntity });
}

export function LaundryWasherEndpoint(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return LaundryWasherType.set({ homeAssistantEntity });
}

export function LaundryDryerEndpoint(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return LaundryDryerType.set({ homeAssistantEntity });
}
