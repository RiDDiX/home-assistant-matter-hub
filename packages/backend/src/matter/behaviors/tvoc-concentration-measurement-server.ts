import {
  type HomeAssistantEntityInformation,
  type SensorDeviceAttributes,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import { TotalVolatileOrganicCompoundsConcentrationMeasurementServer as Base } from "@matter/main/behaviors";
import { ConcentrationMeasurement } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

// Use only NumericMeasurement feature.
// Using both NumericMeasurement and LevelIndication together causes "Behaviors have errors".
const TvocConcentrationMeasurementServerBase = Base.with(
  ConcentrationMeasurement.Feature.NumericMeasurement,
);

/**
 * Determine the correct Matter MeasurementUnit based on the HA device_class.
 * - volatile_organic_compounds: reports in µg/m³ → Ugm3
 * - volatile_organic_compounds_parts: reports in ppb → Ppb
 * Defaults to Ugm3 for maximum controller compatibility (Apple Home requires Ugm3).
 */
function getMeasurementUnit(
  entity: HomeAssistantEntityInformation,
): ConcentrationMeasurement.MeasurementUnit {
  const attributes = entity.state.attributes as SensorDeviceAttributes;
  if (
    attributes.device_class ===
    SensorDeviceClass.volatile_organic_compounds_parts
  ) {
    return ConcentrationMeasurement.MeasurementUnit.Ppb;
  }
  return ConcentrationMeasurement.MeasurementUnit.Ugm3;
}

export class TvocConcentrationMeasurementServer extends TvocConcentrationMeasurementServerBase {
  override async initialize() {
    // Set default values BEFORE super.initialize() to prevent validation errors.
    // Use only NumericMeasurement attributes.
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
        ConcentrationMeasurement.MeasurementUnit.Ugm3;
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

    applyPatchState(this.state, {
      measuredValue,
      measurementUnit: getMeasurementUnit(entity),
    });
  }
}
