// Centralized entity-to-cluster mapping logic for Matter endpoints
// This module provides a single source of truth for mapping Home Assistant entities and mapping configs to Matter clusters and composed device logic.

import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
  MatterDeviceType,
} from "@home-assistant-matter-hub/common";

export interface ClusterMappingResult {
  clusters: string[];
  composed: boolean;
  composedEntities?: string[];
  notes?: string[];
}

/**
 * Returns the list of Matter clusters and composition logic for a given entity and mapping config.
 * This is the single source of truth for all auto-mapping, override, and composition rules.
 */
export function mapEntityToClusters(
  entity: HomeAssistantEntityInformation,
  mapping?: EntityMappingConfig,
): ClusterMappingResult {
  // Example: This logic should be expanded to cover all supported device types and mapping fields.
  const clusters: string[] = [];
  const notes: string[] = [];
  let composed = false;
  let composedEntities: string[] | undefined;

  // Device type override
  const type: MatterDeviceType | undefined = mapping?.matterDeviceType;
  const domain = entity.entity_id.split(".")[0];

  // Example: Light
  const colorModes = (entity.state.attributes as any).supported_color_modes;
  if (
    type === "dimmable_light" ||
    (domain === "light" &&
      Array.isArray(colorModes) &&
      colorModes.includes("brightness"))
  ) {
    clusters.push("OnOff", "LevelControl");
    if (Array.isArray(colorModes) && colorModes.includes("color_temp")) {
      clusters.push("ColorTemperature");
    }
    if (Array.isArray(colorModes) && colorModes.includes("color")) {
      clusters.push("ColorControl");
    }
  } else if (type === "on_off_light" || domain === "light") {
    clusters.push("OnOff");
  }

  // Example: Switch/Plug
  if (
    type === "on_off_plugin_unit" ||
    type === "on_off_switch" ||
    domain === "switch"
  ) {
    clusters.push("OnOff");
    if (mapping?.powerEntity) clusters.push("ElectricalPowerMeasurement");
    if (mapping?.energyEntity) clusters.push("ElectricalEnergyMeasurement");
  }

  // Example: Sensors
  if (type === "temperature_sensor" || mapping?.temperatureEntity) {
    clusters.push("TemperatureMeasurement");
  }
  if (type === "humidity_sensor" || mapping?.humidityEntity) {
    clusters.push("RelativeHumidityMeasurement");
  }
  if (type === "pressure_sensor" || mapping?.pressureEntity) {
    clusters.push("PressureMeasurement");
  }
  if (mapping?.batteryEntity) {
    clusters.push("PowerSource");
  }

  // Example: Composed device (temperature + humidity + pressure)
  if (
    (mapping?.temperatureEntity && mapping?.humidityEntity) ||
    (mapping?.temperatureEntity && mapping?.pressureEntity)
  ) {
    composed = true;
    composedEntities = [
      mapping.temperatureEntity,
      mapping.humidityEntity,
      mapping.pressureEntity,
    ].filter(Boolean) as string[];
    notes.push("Composed device: temperature + humidity/pressure");
  }

  // TODO: Add more device types, plugin hooks, and advanced mapping rules

  return { clusters, composed, composedEntities, notes };
}
