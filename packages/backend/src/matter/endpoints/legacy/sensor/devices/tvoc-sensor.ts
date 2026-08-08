import {
  type HomeAssistantEntityInformation,
  type SensorDeviceAttributes,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { AirQualityServer } from "@matter/main/behaviors";
import { AirQuality } from "@matter/main/clusters";
import { AirQualitySensorDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { TvocConcentrationMeasurementServer } from "../../../../behaviors/tvoc-concentration-measurement-server.js";

const logger = Logger.get("TvocSensor");

/**
 * Map a TVOC value in µg/m³ to an AirQuality enum.
 * Thresholds based on German Federal Environment Agency (UBA) indoor TVOC guidelines.
 */
function airQualityFromUgm3(value: number): AirQuality.AirQualityEnum {
  if (value <= 300) return AirQuality.AirQualityEnum.Good;
  if (value <= 1000) return AirQuality.AirQualityEnum.Fair;
  if (value <= 3000) return AirQuality.AirQualityEnum.Moderate;
  if (value <= 10000) return AirQuality.AirQualityEnum.Poor;
  if (value <= 25000) return AirQuality.AirQualityEnum.VeryPoor;
  return AirQuality.AirQualityEnum.ExtremelyPoor;
}

/**
 * Map a TVOC value in ppb (or VOC Index) to an AirQuality enum.
 * Thresholds based on Sensirion SGP40/41 VOC Index scale (0-500).
 * Many HA sensors with device_class volatile_organic_compounds_parts
 * report a VOC Index rather than true ppb; these thresholds cover both.
 */
function airQualityFromPpb(value: number): AirQuality.AirQualityEnum {
  if (value <= 100) return AirQuality.AirQualityEnum.Good;
  if (value <= 200) return AirQuality.AirQualityEnum.Fair;
  if (value <= 300) return AirQuality.AirQualityEnum.Moderate;
  if (value <= 400) return AirQuality.AirQualityEnum.Poor;
  if (value <= 500) return AirQuality.AirQualityEnum.VeryPoor;
  return AirQuality.AirQualityEnum.ExtremelyPoor;
}

const TvocAirQualityServerBase = AirQualityServer.with(
  AirQuality.Feature.Fair,
  AirQuality.Feature.Moderate,
  AirQuality.Feature.VeryPoor,
  AirQuality.Feature.ExtremelyPoor,
);

class TvocAirQualityServer extends TvocAirQualityServerBase {
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
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const state = entity.state.state;
    const attributes = entity.state.attributes as SensorDeviceAttributes;
    const deviceClass = attributes.device_class;
    let airQuality: AirQuality.AirQualityEnum =
      AirQuality.AirQualityEnum.Unknown;

    logger.debug(
      `[${entity.entity_id}] TVOC update: state="${state}", device_class="${deviceClass}"`,
    );

    if (state != null && !Number.isNaN(+state)) {
      const value = +state;
      // Use device_class to select the correct threshold scale:
      // - volatile_organic_compounds: µg/m³ (UBA guidelines)
      // - volatile_organic_compounds_parts: ppb / VOC Index (Sensirion scale)
      airQuality =
        deviceClass === SensorDeviceClass.volatile_organic_compounds
          ? airQualityFromUgm3(value)
          : airQualityFromPpb(value);
      logger.debug(
        `[${entity.entity_id}] TVOC value=${value} (${deviceClass}) -> airQuality=${AirQuality.AirQualityEnum[airQuality]}`,
      );
    } else {
      logger.warn(
        `[${entity.entity_id}] TVOC state not a valid number: "${state}"`,
      );
    }

    applyPatchState(this.state, { airQuality });
  }
}

export const TvocSensorType = AirQualitySensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  TvocAirQualityServer,
  TvocConcentrationMeasurementServer,
);
