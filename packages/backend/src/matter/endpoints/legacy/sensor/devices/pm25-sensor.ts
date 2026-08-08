import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { Pm25ConcentrationMeasurementServer } from "../../../../behaviors/pm25-concentration-measurement-server.js";

const logger = Logger.get("Pm25AirQualityServer");

const Pm25AirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class Pm25AirQualityServer extends Pm25AirQualityServerBase {
  override async initialize() {
    // Set default value BEFORE super.initialize() to prevent validation errors
    if (this.state.airQuality === undefined) {
      this.state.airQuality = AirQuality.AirQualityEnum.Unknown;
    }
    logger.debug("Pm25AirQualityServer: before super.initialize()");

    await super.initialize();
    logger.debug("Pm25AirQualityServer: after super.initialize()");
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
      // PM2.5 in µg/m³ (US EPA scale)
      if (value <= 12) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (value <= 35) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (value <= 55) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (value <= 150) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else if (value <= 250) {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
      } else {
        airQuality = AirQuality.AirQualityEnum.ExtremelyPoor;
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const Pm25SensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  Pm25AirQualityServer,
  Pm25ConcentrationMeasurementServer,
);
