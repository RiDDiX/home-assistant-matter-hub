import type {
  HomeAssistantEntityInformation,
  SensorDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

const AirQualityServerWithFeatures = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class AirQualitySensorServerImpl extends AirQualityServerWithFeatures {
  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    const state = entity.state.state;
    const attributes = entity.state.attributes as SensorDeviceAttributes;
    const deviceClass = attributes.device_class;

    let airQuality: AirQuality.AirQualityEnum =
      AirQuality.AirQualityEnum.Unknown;

    if (state != null && !Number.isNaN(+state)) {
      const value = +state;

      // Map AQI values to Matter air quality levels
      if (deviceClass === "aqi") {
        // US EPA AQI scale
        if (value <= 50) {
          airQuality = AirQuality.AirQualityEnum.Good;
        } else if (value <= 100) {
          airQuality = AirQuality.AirQualityEnum.Fair;
        } else if (value <= 150) {
          airQuality = AirQuality.AirQualityEnum.Moderate;
        } else if (value <= 200) {
          airQuality = AirQuality.AirQualityEnum.Poor;
        } else if (value <= 300) {
          airQuality = AirQuality.AirQualityEnum.VeryPoor;
        } else {
          airQuality = AirQuality.AirQualityEnum.ExtremelyPoor;
        }
      } else if (deviceClass === "carbon_dioxide") {
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
      } else if (deviceClass === "pm25") {
        // PM2.5 in µg/m³
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
      } else if (deviceClass === "pm10") {
        // PM10 in µg/m³
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
      } else if (
        deviceClass === "volatile_organic_compounds" ||
        deviceClass === "volatile_organic_compounds_parts"
      ) {
        // VOC index or ppb
        if (value <= 100) {
          airQuality = AirQuality.AirQualityEnum.Good;
        } else if (value <= 200) {
          airQuality = AirQuality.AirQualityEnum.Fair;
        } else if (value <= 300) {
          airQuality = AirQuality.AirQualityEnum.Moderate;
        } else if (value <= 400) {
          airQuality = AirQuality.AirQualityEnum.Poor;
        } else {
          airQuality = AirQuality.AirQualityEnum.VeryPoor;
        }
      }
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const AirQualitySensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  AirQualitySensorServerImpl,
);
