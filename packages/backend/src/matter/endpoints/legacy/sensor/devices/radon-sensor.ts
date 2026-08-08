import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { RadonConcentrationMeasurementServer } from "../../../../behaviors/radon-concentration-measurement-server.js";

const RadonAirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class RadonAirQualityServer extends RadonAirQualityServerBase {
  override async initialize() {
    if (this.state.airQuality === undefined) {
      this.state.airQuality = AirQuality.AirQualityEnum.Unknown;
    }

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    const state = entity.state.state;
    let airQuality: AirQuality.AirQualityEnum =
      AirQuality.AirQualityEnum.Unknown;

    if (state != null && !Number.isNaN(+state)) {
      const bqm3 = +state;
      // Radon in Bq/m³, thresholds based on WHO handbook (2009).
      // WHO recommends action level at 100 Bq/m³, national limits often 300 Bq/m³.
      if (bqm3 <= 50) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (bqm3 <= 100) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (bqm3 <= 200) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (bqm3 <= 300) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else if (bqm3 <= 600) {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
      } else {
        airQuality = AirQuality.AirQualityEnum.ExtremelyPoor;
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const RadonSensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  RadonAirQualityServer,
  RadonConcentrationMeasurementServer,
);
