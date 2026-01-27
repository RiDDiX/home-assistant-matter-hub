import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Pm10ConcentrationMeasurementServer as Base } from "@matter/main/behaviors";
import { ConcentrationMeasurement } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const Pm10ConcentrationMeasurementServerBase = Base.with(
  ConcentrationMeasurement.Feature.NumericMeasurement,
);

export class Pm10ConcentrationMeasurementServer extends Pm10ConcentrationMeasurementServerBase {
  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    const state = entity.state.state;
    let measuredValue: number | null = null;

    if (state != null && !Number.isNaN(+state)) {
      measuredValue = +state;
    }

    applyPatchState(this.state, {
      measuredValue,
      measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ugm3,
      measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
    });
  }
}
