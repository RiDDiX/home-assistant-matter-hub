import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { CarbonMonoxideConcentrationMeasurementServer } from "../../../../behaviors/carbon-monoxide-concentration-measurement-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

const CoAirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class CoAirQualityServer extends CoAirQualityServerBase {
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
      const ppm = +state;
      // CO in ppm, thresholds based on WHO indoor air quality guidelines.
      if (ppm <= 9) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (ppm <= 25) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (ppm <= 50) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (ppm <= 100) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else if (ppm <= 200) {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
      } else {
        airQuality = AirQuality.AirQualityEnum.ExtremelyPoor;
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const CarbonMonoxideSensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  CoAirQualityServer,
  CarbonMonoxideConcentrationMeasurementServer,
);
