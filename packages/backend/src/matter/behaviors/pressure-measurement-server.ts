import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { PressureMeasurementServer as Base } from "@matter/main/behaviors";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter } from "./utils/cluster-config.js";

export interface PressureMeasurementConfig {
  getValue: ValueGetter<number | undefined>;
}

export class PressureMeasurementServerBase extends Base {
  declare state: PressureMeasurementServerBase.State;

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
    applyPatchState(this.state, {
      measuredValue: this.getPressure(entity.state) ?? null,
    });
  }

  private getPressure(entity: HomeAssistantEntityState): number | undefined {
    const value = this.state.config.getValue(entity, this.agent);
    if (value == null) {
      return undefined;
    }
    // Matter expects pressure in kPa * 10 (decikiloPascals)
    // Home Assistant typically reports in hPa (hectoPascals)
    // 1 hPa = 0.1 kPa, so hPa / 10 = kPa, then * 10 = dkPa
    // Result: hPa value directly equals dkPa
    return Math.round(value);
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
