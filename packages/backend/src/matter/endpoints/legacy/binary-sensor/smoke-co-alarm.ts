import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { SmokeCoAlarmServer as Base } from "@matter/main/behaviors/smoke-co-alarm";
import { SmokeCoAlarm } from "@matter/main/clusters";
import { SmokeCoAlarmDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";

const SmokeCoAlarmServerWithFeatures = Base.with(
  SmokeCoAlarm.Feature.SmokeAlarm,
  SmokeCoAlarm.Feature.CoAlarm,
);

class SmokeCoAlarmServerImpl extends SmokeCoAlarmServerWithFeatures {
  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    const isOn =
      this.agent.get(HomeAssistantEntityBehavior).isAvailable &&
      entity.state.state === "on";
    const deviceClass = entity.state.attributes?.device_class;

    if (deviceClass === "smoke") {
      applyPatchState(this.state, {
        smokeState: isOn
          ? SmokeCoAlarm.AlarmState.Warning
          : SmokeCoAlarm.AlarmState.Normal,
        coState: SmokeCoAlarm.AlarmState.Normal,
      });
    } else if (deviceClass === "carbon_monoxide" || deviceClass === "gas") {
      applyPatchState(this.state, {
        coState: isOn
          ? SmokeCoAlarm.AlarmState.Warning
          : SmokeCoAlarm.AlarmState.Normal,
        smokeState: SmokeCoAlarm.AlarmState.Normal,
      });
    } else {
      applyPatchState(this.state, {
        smokeState: isOn
          ? SmokeCoAlarm.AlarmState.Warning
          : SmokeCoAlarm.AlarmState.Normal,
      });
    }
  }
}

export const SmokeCoAlarmType = SmokeCoAlarmDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  SmokeCoAlarmServerImpl,
);
