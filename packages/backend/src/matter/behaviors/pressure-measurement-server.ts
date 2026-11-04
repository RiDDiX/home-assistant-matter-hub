import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { PressureMeasurementServer as Base } from "@matter/main/behaviors";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter } from "./utils/cluster-config.js";

// min/max values in dkPa (decikiloPascals). The declared window must cover
// everything getPressure can write, or matter.js rejects the value and the
// attribute freezes, so boiler and tyre sensors in bar or psi fit as well.
const MIN_PRESSURE = 0;
const MAX_PRESSURE = 32767;

export interface PressureMeasurementConfig {
  getValue: ValueGetter<number | undefined>;
}

export class PressureMeasurementServerBase extends Base {
  declare state: PressureMeasurementServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, {
      offline: true,
      lock: true,
    });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const pressure = this.getPressure(entity.state);
    applyPatchState(this.state, {
      measuredValue: pressure,
      minMeasuredValue: MIN_PRESSURE,
      maxMeasuredValue: MAX_PRESSURE,
    });
  }

  private getPressure(entity: HomeAssistantEntityState): number | null {
    const value = this.state.config.getValue(entity, this.agent);
    if (value == null) {
      return null;
    }
    // Matter expects pressure in kPa * 10 (decikiloPascals)
    // Home Assistant typically reports in hPa (hectoPascals)
    // 1 hPa = 0.1 kPa, so hPa / 10 = kPa, then * 10 = dkPa
    // Result: hPa value directly equals dkPa
    return Math.min(MAX_PRESSURE, Math.max(MIN_PRESSURE, Math.round(value)));
  }
}

export namespace PressureMeasurementServerBase {
  export class State extends Base.State {
    config!: PressureMeasurementConfig;
  }
}

export function PressureMeasurementServer(config: PressureMeasurementConfig) {
  return PressureMeasurementServerBase.set({ config });
}
