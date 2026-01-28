import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { PumpConfigurationAndControlServer as Base } from "@matter/main/behaviors/pump-configuration-and-control";
import { PumpConfigurationAndControl } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

export class PumpConfigurationAndControlServerBase extends Base {
  declare state: PumpConfigurationAndControlServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state) {
      return;
    }
    const isOn =
      this.agent.get(HomeAssistantEntityBehavior).isAvailable &&
      entity.state.state === "on";

    applyPatchState(this.state, {
      effectiveOperationMode: isOn
        ? PumpConfigurationAndControl.OperationMode.Normal
        : PumpConfigurationAndControl.OperationMode.Minimum,
      effectiveControlMode:
        PumpConfigurationAndControl.ControlMode.ConstantSpeed,
      capacity: null,
    });
  }
}

export namespace PumpConfigurationAndControlServerBase {
  export class State extends Base.State {}
}

export const PumpConfigurationAndControlServer =
  PumpConfigurationAndControlServerBase.set({
    maxPressure: null,
    maxSpeed: null,
    maxFlow: null,
    effectiveOperationMode: PumpConfigurationAndControl.OperationMode.Normal,
    effectiveControlMode: PumpConfigurationAndControl.ControlMode.ConstantSpeed,
    capacity: null,
    operationMode: PumpConfigurationAndControl.OperationMode.Normal,
  });
