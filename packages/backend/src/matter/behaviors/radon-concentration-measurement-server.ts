import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { RadonConcentrationMeasurementServer as Base } from "@matter/main/behaviors";
import { ConcentrationMeasurement } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const RadonConcentrationMeasurementServerBase = Base.with(
  ConcentrationMeasurement.Feature.NumericMeasurement,
);

export class RadonConcentrationMeasurementServer extends RadonConcentrationMeasurementServerBase {
  override async initialize() {
    if (this.state.measuredValue === undefined) {
      this.state.measuredValue = null;
    }
    if (this.state.minMeasuredValue === undefined) {
      this.state.minMeasuredValue = null;
    }
    if (this.state.maxMeasuredValue === undefined) {
      this.state.maxMeasuredValue = null;
    }
    if (this.state.uncertainty === undefined) {
      this.state.uncertainty = 0;
    }
    if (this.state.measurementUnit === undefined) {
      this.state.measurementUnit =
        ConcentrationMeasurement.MeasurementUnit.Bqm3;
    }
    if (this.state.measurementMedium === undefined) {
      this.state.measurementMedium =
        ConcentrationMeasurement.MeasurementMedium.Air;
    }

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const state = entity.state.state;
    let measuredValue: number | null = null;

    if (state != null && !Number.isNaN(+state)) {
      measuredValue = +state;
    }

    applyPatchState(this.state, { measuredValue });
  }
}
