import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { CarbonDioxideConcentrationMeasurementServer } from "../../../../behaviors/carbon-dioxide-concentration-measurement-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

const Co2AirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class Co2AirQualityServer extends Co2AirQualityServerBase {
  override async initialize() {
    // Set default value BEFORE super.initialize() to prevent validation errors
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
      const value = +state;
      // CO2 in ppm - thresholds based on German UBA / ASHRAE indoor air quality guidelines.
      // Outdoor CO2 is ~420 ppm (2024+), well-ventilated indoor ~450-600 ppm.
      if (value <= 800) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (value <= 1000) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (value <= 1400) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (value <= 2000) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else if (value <= 5000) {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
      } else {
        airQuality = AirQuality.AirQualityEnum.ExtremelyPoor;
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const Co2SensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  Co2AirQualityServer,
  CarbonDioxideConcentrationMeasurementServer,
);
