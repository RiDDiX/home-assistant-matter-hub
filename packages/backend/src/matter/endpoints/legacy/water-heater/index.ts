import type { WaterHeaterDeviceAttributes } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import { ThermostatDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { ThermostatUiConfigServer } from "../../../behaviors/thermostat-ui-config-server.js";
import { WaterHeaterThermostatServer } from "./behaviors/water-heater-thermostat-server.js";

const logger = Logger.get("WaterHeaterDevice");

const WaterHeaterDeviceType = ThermostatDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  WaterHeaterThermostatServer,
  ThermostatUiConfigServer,
);

/**
 * Convert HA temperature to Matter temperature (0.01°C units).
 * Returns undefined if value is null/undefined/invalid.
 */
export function toMatterTemp(
  value: string | number | null | undefined,
): number | undefined {
  if (value == null) return undefined;
  const num = typeof value === "string" ? Number.parseFloat(value) : value;
  if (Number.isNaN(num)) return undefined;
  return Math.round(num * 100);
}

export function WaterHeaterDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as WaterHeaterDeviceAttributes;

  logger.debug(
    `Creating device for ${homeAssistantEntity.entity.entity_id}, min_temp=${attributes.min_temp}, max_temp=${attributes.max_temp}`,
  );

  // Water heaters (kettles, boilers) typically operate above 50°C.
  // Use HA's actual limits, fall back to wide range (0-120°C) for water heaters.
  const minLimit = toMatterTemp(attributes.min_temp) ?? 0;
  const maxLimit = toMatterTemp(attributes.max_temp) ?? 12000;
  const currentTemp =
    toMatterTemp(attributes.current_temperature) ??
    toMatterTemp(attributes.temperature) ??
    2100;
  const heatingSetpoint = toMatterTemp(attributes.temperature) ?? 10000;

  // Pass thermostat state at endpoint level, Matter.js reads from here during
  // validation, BEFORE our initialize() runs. Without this, limits fall back to
  // the default 0-50°C range (#145, regression from #97 fix).
  // Only include heating attributes since water heater uses heating-only features.
  return WaterHeaterDeviceType.set({
    homeAssistantEntity,
    thermostat: {
      localTemperature: currentTemp,
      occupiedHeatingSetpoint: heatingSetpoint,
      minHeatSetpointLimit: minLimit,
      maxHeatSetpointLimit: maxLimit,
      absMinHeatSetpointLimit: minLimit,
      absMaxHeatSetpointLimit: maxLimit,
    },
  });
}
