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
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    const state = entity.state.state;
    let airQuality: AirQuality.AirQualityEnum =
      AirQuality.AirQualityEnum.Unknown;

    if (state != null && !Number.isNaN(+state)) {
      const value = +state;
      // CO2 in ppm
      if (value < 400) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (value < 1000) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (value < 2000) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (value < 5000) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
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
