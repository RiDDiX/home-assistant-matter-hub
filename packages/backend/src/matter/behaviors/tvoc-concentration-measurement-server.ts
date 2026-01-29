import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { TotalVolatileOrganicCompoundsConcentrationMeasurementServer as Base } from "@matter/main/behaviors";
import { ConcentrationMeasurement } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const TvocConcentrationMeasurementServerBase = Base.with(
  ConcentrationMeasurement.Feature.NumericMeasurement,
);

export class TvocConcentrationMeasurementServer extends TvocConcentrationMeasurementServerBase {
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
    const state = entity.state.state;
    let measuredValue: number | null = null;

    if (state != null && !Number.isNaN(+state)) {
      measuredValue = +state;
    }

    applyPatchState(this.state, {
      measuredValue,
      measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ppb,
      measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
    });
  }
}
