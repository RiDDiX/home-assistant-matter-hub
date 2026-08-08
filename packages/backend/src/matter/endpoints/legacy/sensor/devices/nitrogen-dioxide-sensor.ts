import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { NitrogenDioxideConcentrationMeasurementServer } from "../../../../behaviors/nitrogen-dioxide-concentration-measurement-server.js";

const No2AirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class No2AirQualityServer extends No2AirQualityServerBase {
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
      const ugm3 = +state;
      // NO₂ in µg/m³, thresholds based on WHO air quality guidelines (2021).
      if (ugm3 <= 25) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (ugm3 <= 50) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (ugm3 <= 100) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (ugm3 <= 200) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else if (ugm3 <= 400) {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
      } else {
        airQuality = AirQuality.AirQualityEnum.ExtremelyPoor;
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const NitrogenDioxideSensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  No2AirQualityServer,
  NitrogenDioxideConcentrationMeasurementServer,
);
