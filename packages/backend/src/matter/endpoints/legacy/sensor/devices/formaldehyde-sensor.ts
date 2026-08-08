import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { FormaldehydeConcentrationMeasurementServer } from "../../../../behaviors/formaldehyde-concentration-measurement-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

const FormaldehydeAirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class FormaldehydeAirQualityServer extends FormaldehydeAirQualityServerBase {
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
      // HCHO in µg/m³, thresholds based on WHO indoor air quality guidelines.
      // WHO recommends 100 µg/m³ (30-min average).
      if (ugm3 <= 30) {
        airQuality = AirQuality.AirQualityEnum.Good;
      } else if (ugm3 <= 60) {
        airQuality = AirQuality.AirQualityEnum.Fair;
      } else if (ugm3 <= 100) {
        airQuality = AirQuality.AirQualityEnum.Moderate;
      } else if (ugm3 <= 200) {
        airQuality = AirQuality.AirQualityEnum.Poor;
      } else if (ugm3 <= 500) {
        airQuality = AirQuality.AirQualityEnum.VeryPoor;
      } else {
        airQuality = AirQuality.AirQualityEnum.ExtremelyPoor;
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const FormaldehydeSensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  FormaldehydeAirQualityServer,
  FormaldehydeConcentrationMeasurementServer,
);
