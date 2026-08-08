import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { RelativeHumidityMeasurementServer as Base } from "@matter/main/behaviors";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter } from "./utils/cluster-config.js";

const logger = Logger.get("HumidityMeasurementServer");

export interface HumidityMeasurementConfig {
  getValue: ValueGetter<number | null>;
}

// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class HumidityMeasurementServerBase extends Base {
  declare state: HumidityMeasurementServerBase.State;

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
    const humidity = this.getHumidity(this.state.config, entity.state);
    logger.debug(
      `Humidity ${entity.state.entity_id} raw=${entity.state.state} measuredValue=${humidity}`,
    );
    applyPatchState(this.state, {
      measuredValue: humidity,
      minMeasuredValue: 0,
      maxMeasuredValue: 10000,
    });
  }

  private getHumidity(
    config: HumidityMeasurementConfig,
    entity: HomeAssistantEntityState,
  ): number | null {
    const humidity = config.getValue(entity, this.agent);
    if (humidity == null) {
      return null;
    }
    return Math.round(humidity * 100);
  }
}

namespace HumidityMeasurementServerBase {
  export class State extends Base.State {
    config!: HumidityMeasurementConfig;
  }
}

export function HumidityMeasurementServer(config: HumidityMeasurementConfig) {
  return HumidityMeasurementServerBase.set({ config });
}
