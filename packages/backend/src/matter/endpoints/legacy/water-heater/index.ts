import type { WaterHeaterDeviceAttributes } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { ThermostatDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { WaterHeaterThermostatServer } from "./behaviors/water-heater-thermostat-server.js";

const WaterHeaterDeviceType = ThermostatDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  WaterHeaterThermostatServer,
);

export function WaterHeaterDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as WaterHeaterDeviceAttributes;

  // Log for debugging
  console.log(
    `[WaterHeater] Creating device for ${homeAssistantEntity.entity.entity_id}`,
    `min_temp=${attributes.min_temp}, max_temp=${attributes.max_temp}`,
  );

  return WaterHeaterDeviceType.set({ homeAssistantEntity });
}
