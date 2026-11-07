import type { FanDeviceAttributes } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { AirPurifierDevice as Device } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { FanSpeedMemoryBehavior } from "../../../behaviors/fan-speed-memory.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { FanFanControlServer } from "../fan/behaviors/fan-fan-control-server.js";
import { FanOnOffServer } from "../fan/behaviors/fan-on-off-server.js";
import { fanControlFeatures } from "../fan/index.js";
import { AirPurifierHepaFilterMonitoringServer } from "./behaviors/air-purifier-hepa-filter-monitoring-server.js";

// Extended attributes interface for filter life support
interface AirPurifierAttributes extends FanDeviceAttributes {
  filter_life?: number;
  filter_life_remaining?: number;
  filter_life_level?: number;
}

/**
 * Check if filter life information is available.
 * Either as an attribute on the entity or via a mapped sensor entity.
 */
function hasFilterLifeSupport(
  attributes: AirPurifierAttributes,
  mapping?: HomeAssistantEntityBehavior.State["mapping"],
): boolean {
  // Check for direct attribute on the fan entity
  if (
    attributes.filter_life != null ||
    attributes.filter_life_remaining != null ||
    attributes.filter_life_level != null
  ) {
    return true;
  }
  // Check for mapped filter life sensor entity
  if (mapping?.filterLifeEntity) {
    return true;
  }
  return false;
}

export function AirPurifierEndpoint(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as AirPurifierAttributes;
  const mapping = homeAssistantEntity.mapping;
  const features = fanControlFeatures(attributes, mapping);

  // Base device with fan control behaviors
  const baseDevice = Device.with(
    IdentifyServer,
    BasicInformationServer,
    HomeAssistantEntityBehavior,
    FanOnOffServer,
    FanFanControlServer.with(...features),
    FanSpeedMemoryBehavior,
  );

  // Add HEPA filter monitoring if filter life is available (attribute or mapped sensor)
  if (hasFilterLifeSupport(attributes, mapping)) {
    const deviceWithFilter = baseDevice.with(
      AirPurifierHepaFilterMonitoringServer,
    );
    return deviceWithFilter.set({ homeAssistantEntity });
  }

  return baseDevice.set({ homeAssistantEntity });
}
