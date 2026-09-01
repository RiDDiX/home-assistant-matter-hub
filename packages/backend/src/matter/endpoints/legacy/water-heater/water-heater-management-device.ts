import type { WaterHeaterDeviceAttributes } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import { WaterHeaterDevice as MatterWaterHeaterDevice } from "@matter/main/devices";
import { toMatterTemp } from "../../../../utils/converters/temperature.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { ThermostatUiConfigServer } from "../../../behaviors/thermostat-ui-config-server.js";
import { WaterHeaterBoostMemoryBehavior } from "./behaviors/water-heater-boost-memory.js";
import { WaterHeaterManagementServer } from "./behaviors/water-heater-management-server.js";
import { WaterHeaterModeServer } from "./behaviors/water-heater-mode-server.js";
import { WaterHeaterThermostatServer } from "./behaviors/water-heater-thermostat-server.js";
import {
  buildModeMapping,
  currentMode,
  heaterTypes,
} from "./water-heater-modes.js";

const logger = Logger.get("WaterHeaterManagementDevice");

/**
 * Matter 1.4 Water Heater (0x050F): WaterHeaterManagement with Boost /
 * CancelBoost, WaterHeaterMode and a heating-only Thermostat on one endpoint.
 *
 * Opt-in through the `water_heater_management` device type override. The
 * default for the water_heater domain stays the plain Thermostat device,
 * because swapping the clusters on an endpoint breaks controllers that have
 * already paired it, and no mainstream controller renders 0x050F yet.
 */
export function WaterHeaterManagementDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const entityState = homeAssistantEntity.entity.state;
  const attributes = entityState.attributes as WaterHeaterDeviceAttributes;

  const modeMapping = buildModeMapping(attributes);
  const initialMode = currentMode(modeMapping, entityState.state, attributes);

  logger.debug(
    `Creating Matter 1.4 water heater for ${homeAssistantEntity.entity.entity_id}, ` +
      `modes=[${modeMapping.supportedModes.map((m) => `${m.mode}:${m.label}`).join(", ")}], ` +
      `boostMode=${modeMapping.boostOperationMode ?? "none"}`,
  );

  const minLimit = toMatterTemp(attributes.min_temp) ?? 0;
  const maxLimit = toMatterTemp(attributes.max_temp) ?? 12000;
  const currentTemp =
    toMatterTemp(attributes.current_temperature) ??
    toMatterTemp(attributes.temperature) ??
    2100;
  const heatingSetpoint = toMatterTemp(attributes.temperature) ?? 10000;

  return MatterWaterHeaterDevice.with(
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    WaterHeaterThermostatServer,
    ThermostatUiConfigServer,
    WaterHeaterManagementServer(modeMapping, heaterTypes(attributes)),
    WaterHeaterBoostMemoryBehavior,
    WaterHeaterModeServer(modeMapping, initialMode),
  ).set({
    homeAssistantEntity,
    // matter.js validates the thermostat limits before initialize() runs, so
    // they have to ride along on the endpoint (#145).
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
