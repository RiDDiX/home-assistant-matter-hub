import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { IlluminanceMeasurementServer as Base } from "@matter/main/behaviors";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter } from "./utils/cluster-config.js";

export interface IlluminanceMeasurementConfig {
  getValue: ValueGetter<number | null>;
}

// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class IlluminanceMeasurementServerBase extends Base {
  declare state: IlluminanceMeasurementServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const illuminance = this.getIlluminance(this.state.config, entity.state);
    applyPatchState(this.state, {
      measuredValue: illuminance,
      // min/max values: 1 (min valid) to 0xFFFE (max illuminance in log scale)
      // Matter spec requires minMeasuredValue >= 1 for IlluminanceMeasurement
      minMeasuredValue: 1,
      maxMeasuredValue: 0xfffe,
    });
  }

  private getIlluminance(
    config: IlluminanceMeasurementConfig,
    entity: HomeAssistantEntityState,
  ): number | null {
    const illuminance = config.getValue(entity, this.agent);
    if (illuminance == null) {
      return null;
    }

    if (illuminance < 1) {
      return 0;
    }

    const measuredValue = Math.round(10000 * Math.log10(illuminance) + 1);
    return Math.min(0xfffe, Math.max(1, measuredValue));
  }
}

namespace IlluminanceMeasurementServerBase {
  export class State extends Base.State {
    config!: IlluminanceMeasurementConfig;
  }
}

export function IlluminanceMeasurementServer(
  config: IlluminanceMeasurementConfig,
) {
  return IlluminanceMeasurementServerBase.set({ config });
}
