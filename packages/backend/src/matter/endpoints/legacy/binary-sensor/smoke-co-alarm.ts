import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { SmokeCoAlarmServer as Base } from "@matter/main/behaviors/smoke-co-alarm";
import { SmokeCoAlarm } from "@matter/main/clusters";
import { SmokeCoAlarmDevice } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { applyPatchState } from "../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { PowerSourceServer } from "../../../behaviors/power-source-server.js";

// Battery source shared by the PowerSource and the batteryAlert, so both read
// the exact same value: a mapped battery entity, else the alarm's own attribute.
function getBatteryPercent(
  entity: HomeAssistantEntityState,
  agent: Agent,
): number | null {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const batteryEntity = homeAssistant.state.mapping?.batteryEntity;
  if (batteryEntity) {
    const stateProvider = agent.env.get(EntityStateProvider);
    const battery = stateProvider.getBatteryPercent(batteryEntity);
    if (battery != null) {
      return Math.max(0, Math.min(100, battery));
    }
  }

  const attrs = entity.attributes as {
    battery?: number;
    battery_level?: number;
  };
  const level = attrs.battery_level ?? attrs.battery;
  if (level == null || Number.isNaN(Number(level))) {
    return null;
  }
  return Number(level);
}

// batteryAlert reuses the PowerSource thresholds (<=10 Critical, <=20 Warning).
// A binary low-battery sensor only signals "low", so treat its "on" as Warning.
function getBatteryAlert(
  entity: HomeAssistantEntityState,
  agent: Agent,
): SmokeCoAlarm.AlarmState {
  const batteryEntity = agent.get(HomeAssistantEntityBehavior).state.mapping
    ?.batteryEntity;
  if (batteryEntity?.startsWith("binary_sensor.")) {
    const state = agent.env.get(EntityStateProvider).getState(batteryEntity);
    return state?.state === "on"
      ? SmokeCoAlarm.AlarmState.Warning
      : SmokeCoAlarm.AlarmState.Normal;
  }

  const percent = getBatteryPercent(entity, agent);
  if (percent == null) return SmokeCoAlarm.AlarmState.Normal;
  if (percent <= 10) return SmokeCoAlarm.AlarmState.Critical;
  if (percent <= 20) return SmokeCoAlarm.AlarmState.Warning;
  return SmokeCoAlarm.AlarmState.Normal;
}

// hardwareFaultAlert comes from a same-device problem/safety sensor (#408).
function getHardwareFault(agent: Agent): boolean {
  const faultEntity = agent.get(HomeAssistantEntityBehavior).state.mapping
    ?.faultEntity;
  if (!faultEntity) return false;
  return (
    agent.env.get(EntityStateProvider).getState(faultEntity)?.state === "on"
  );
}

// expressedState is the highest-priority active condition per Matter spec:
// an active smoke/CO alarm beats a battery alert beats a hardware fault.
function getExpressedState(
  primary: SmokeCoAlarm.AlarmState,
  active: SmokeCoAlarm.ExpressedState,
  battery: SmokeCoAlarm.AlarmState,
  fault: boolean,
): SmokeCoAlarm.ExpressedState {
  if (primary !== SmokeCoAlarm.AlarmState.Normal) return active;
  if (battery !== SmokeCoAlarm.AlarmState.Normal)
    return SmokeCoAlarm.ExpressedState.BatteryAlert;
  if (fault) return SmokeCoAlarm.ExpressedState.HardwareFault;
  return SmokeCoAlarm.ExpressedState.Normal;
}

const SmokeAlarmServerWithFeature = Base.with(SmokeCoAlarm.Feature.SmokeAlarm);
const CoAlarmServerWithFeature = Base.with(SmokeCoAlarm.Feature.CoAlarm);

class SmokeAlarmServerImpl extends SmokeAlarmServerWithFeature {
  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    const isOn =
      this.agent.get(HomeAssistantEntityBehavior).isAvailable &&
      entity.state.state === "on";
    const smokeState = isOn
      ? SmokeCoAlarm.AlarmState.Warning
      : SmokeCoAlarm.AlarmState.Normal;
    const batteryAlert = getBatteryAlert(entity.state, this.agent);
    const hardwareFaultAlert = getHardwareFault(this.agent);
    applyPatchState(this.state, {
      smokeState,
      batteryAlert,
      hardwareFaultAlert,
      expressedState: getExpressedState(
        smokeState,
        SmokeCoAlarm.ExpressedState.SmokeAlarm,
        batteryAlert,
        hardwareFaultAlert,
      ),
    });
  }
}

class CoAlarmServerImpl extends CoAlarmServerWithFeature {
  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    const isOn =
      this.agent.get(HomeAssistantEntityBehavior).isAvailable &&
      entity.state.state === "on";
    const coState = isOn
      ? SmokeCoAlarm.AlarmState.Warning
      : SmokeCoAlarm.AlarmState.Normal;
    const batteryAlert = getBatteryAlert(entity.state, this.agent);
    const hardwareFaultAlert = getHardwareFault(this.agent);
    applyPatchState(this.state, {
      coState,
      batteryAlert,
      hardwareFaultAlert,
      expressedState: getExpressedState(
        coState,
        SmokeCoAlarm.ExpressedState.CoAlarm,
        batteryAlert,
        hardwareFaultAlert,
      ),
    });
  }
}

// PowerSource configuration for battery-powered smoke/CO alarms
const AlarmPowerSourceServer = PowerSourceServer({ getBatteryPercent });

export const SmokeAlarmType = SmokeCoAlarmDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  SmokeAlarmServerImpl,
);

export const SmokeAlarmWithBatteryType = SmokeCoAlarmDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  SmokeAlarmServerImpl,
  AlarmPowerSourceServer,
);

export const CoAlarmType = SmokeCoAlarmDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  CoAlarmServerImpl,
);

export const CoAlarmWithBatteryType = SmokeCoAlarmDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  CoAlarmServerImpl,
  AlarmPowerSourceServer,
);
