import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { OperationalStateServer as Base } from "@matter/main/behaviors/operational-state";
import { OperationalState } from "@matter/main/clusters/operational-state";
import { DishwasherDevice as Device } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { applyPatchState } from "../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

// Switch words, plus the states Home Connect and SmartThings report (#486).
const haStateToDishwasherState: Record<
  string,
  OperationalState.OperationalStateEnum
> = {
  off: OperationalState.OperationalStateEnum.Stopped,
  idle: OperationalState.OperationalStateEnum.Stopped,
  standby: OperationalState.OperationalStateEnum.Stopped,
  on: OperationalState.OperationalStateEnum.Running,
  running: OperationalState.OperationalStateEnum.Running,
  active: OperationalState.OperationalStateEnum.Running,
  drying: OperationalState.OperationalStateEnum.Running,
  washing: OperationalState.OperationalStateEnum.Running,
  paused: OperationalState.OperationalStateEnum.Paused,
  complete: OperationalState.OperationalStateEnum.Stopped,
  finished: OperationalState.OperationalStateEnum.Stopped,
  inactive: OperationalState.OperationalStateEnum.Stopped,
  ready: OperationalState.OperationalStateEnum.Stopped,
  delayedstart: OperationalState.OperationalStateEnum.Stopped,
  run: OperationalState.OperationalStateEnum.Running,
  pause: OperationalState.OperationalStateEnum.Paused,
  // waiting for the user
  actionrequired: OperationalState.OperationalStateEnum.Paused,
  aborting: OperationalState.OperationalStateEnum.Running,
  error: OperationalState.OperationalStateEnum.Error,
  stop: OperationalState.OperationalStateEnum.Stopped,
};

class DishwasherOperationalStateServer extends Base {
  override async initialize() {
    this.state.operationalStateList = [
      { operationalStateId: OperationalState.OperationalStateEnum.Stopped },
      { operationalStateId: OperationalState.OperationalStateEnum.Running },
      { operationalStateId: OperationalState.OperationalStateEnum.Paused },
      { operationalStateId: OperationalState.OperationalStateEnum.Error },
    ];
    this.state.operationalState = OperationalState.OperationalStateEnum.Stopped;
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
    const haState = raw?.toLowerCase() ?? "off";
    const newState =
      haStateToDishwasherState[haState] ??
      OperationalState.OperationalStateEnum.Stopped;
    applyPatchState(this.state, {
      operationalState: newState,
      operationalError: {
        errorStateId:
          newState === OperationalState.OperationalStateEnum.Error
            ? OperationalState.ErrorState.UnableToCompleteOperation
            : OperationalState.ErrorState.NoError,
      },
    });
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

const DishwasherOnOffServer = OnOffServer({
  turnOn: () => ({
    action: "homeassistant.turn_on",
  }),
  turnOff: () => ({
    action: "homeassistant.turn_off",
  }),
});

const DishwasherDeviceType = Device.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  DishwasherOperationalStateServer,
  DishwasherOnOffServer,
);

export function DishwasherEndpoint(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return DishwasherDeviceType.set({ homeAssistantEntity });
}
