import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { OzoneConcentrationMeasurementServer } from "../../../../behaviors/ozone-concentration-measurement-server.js";

const OzoneAirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class OzoneAirQualityServer extends OzoneAirQualityServerBase {
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
      // O₃ in µg/m³, thresholds based on WHO air quality guidelines (2021).
      if (ugm3 <= 60) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (ugm3 <= 100) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (ugm3 <= 140) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (ugm3 <= 180) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else if (ugm3 <= 240) {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
      } else {
        airQuality = AirQuality.AirQualityEnum.ExtremelyPoor;
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const OzoneSensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  OzoneAirQualityServer,
  OzoneConcentrationMeasurementServer,
);
