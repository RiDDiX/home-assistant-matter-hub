import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { PressureMeasurementServer as Base } from "@matter/main/behaviors";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter } from "./utils/cluster-config.js";

const logger = Logger.get("PressureMeasurementServer");

// min/max values in dkPa (decikiloPascals): 300-1100 hPa typical atmospheric range
const MIN_PRESSURE = 300;
const MAX_PRESSURE = 1100;

export interface PressureMeasurementConfig {
  getValue: ValueGetter<number | undefined>;
}

export class PressureMeasurementServerBase extends Base {
  declare state: PressureMeasurementServerBase.State;

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
    const rounded = Math.round(value);
    if (rounded < MIN_PRESSURE || rounded > MAX_PRESSURE) {
      logger.warn(
        `Pressure value ${rounded} (raw: ${value}) for ${entity.entity_id} is outside valid range [${MIN_PRESSURE}-${MAX_PRESSURE}], ignoring`,
      );
      return null;
    }
    return rounded;
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
