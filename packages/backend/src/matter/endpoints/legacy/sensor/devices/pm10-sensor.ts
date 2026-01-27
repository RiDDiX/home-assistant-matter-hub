import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { Pm10ConcentrationMeasurementServer } from "../../../../behaviors/pm10-concentration-measurement-server.js";

const Pm10AirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class Pm10AirQualityServer extends Pm10AirQualityServerBase {
  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    const state = entity.state.state;
    let airQuality: AirQuality.AirQualityEnum = AirQuality.AirQualityEnum.Unknown;

    if (state != null && !Number.isNaN(+state)) {
      const value = +state;
      // PM10 in µg/m³ (US EPA scale)
      if (value <= 54) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (value <= 154) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (value <= 254) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (value <= 354) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const Pm10SensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  Pm10AirQualityServer,
  Pm10ConcentrationMeasurementServer,
);
