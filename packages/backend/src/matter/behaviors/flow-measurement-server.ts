import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { FlowMeasurementServer as Base } from "@matter/main/behaviors";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter } from "./utils/cluster-config.js";

export interface FlowMeasurementConfig {
  getValue: ValueGetter<number | undefined>;
}

export class FlowMeasurementServerBase extends Base {
  declare state: FlowMeasurementServerBase.State;

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
      measuredValue: this.getFlow(entity.state) ?? null,
    });
  }

  private getFlow(entity: HomeAssistantEntityState): number | undefined {
    const value = this.state.config.getValue(entity, this.agent);
    if (value == null) {
      return undefined;
    }
    // Matter expects flow in m³/h * 10 (0.1 m³/h resolution)
    return Math.round(value * 10);
  }
}

export namespace FlowMeasurementServerBase {
  export class State extends Base.State {
    config!: FlowMeasurementConfig;
  }
}

export function FlowMeasurementServer(config: FlowMeasurementConfig) {
  return FlowMeasurementServerBase.set({ config });
}
