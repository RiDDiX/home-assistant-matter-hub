import type { HomeAssistantDomain } from "./home-assistant-domain.js";

export type MatterDeviceType =
  | "on_off_light"
  | "dimmable_light"
  | "color_temperature_light"
  | "extended_color_light"
  | "on_off_switch"
  | "dimmer_switch"
  | "color_dimmer_switch"
  | "contact_sensor"
  | "occupancy_sensor"
  | "light_sensor"
  | "temperature_sensor"
  | "humidity_sensor"
  | "pressure_sensor"
  | "flow_sensor"
  | "on_off_plugin_unit"
  | "dimmable_plugin_unit"
  | "door_lock"
  | "window_covering"
  | "thermostat"
  | "fan"
  | "air_quality_sensor"
  | "generic_switch"
  | "speaker"
  | "robot_vacuum_cleaner"
  | "humidifier_dehumidifier"
  | "smoke_co_alarm"
  | "water_leak_detector";

export interface EntityMappingConfig {
  readonly entityId: string;
  readonly matterDeviceType?: MatterDeviceType;
  readonly customName?: string;
  readonly disabled?: boolean;
}

export interface EntityMappingRequest {
  readonly bridgeId: string;
  readonly entityId: string;
  readonly matterDeviceType?: MatterDeviceType;
  readonly customName?: string;
  readonly disabled?: boolean;
}

export interface EntityMappingResponse {
  readonly bridgeId: string;
  readonly mappings: EntityMappingConfig[];
}

export const matterDeviceTypeLabels: Record<MatterDeviceType, string> = {
  on_off_light: "On/Off Light",
  dimmable_light: "Dimmable Light",
  color_temperature_light: "Color Temperature Light",
  extended_color_light: "Extended Color Light",
  on_off_switch: "On/Off Switch",
  dimmer_switch: "Dimmer Switch",
  color_dimmer_switch: "Color Dimmer Switch",
  contact_sensor: "Contact Sensor",
  occupancy_sensor: "Occupancy Sensor",
  light_sensor: "Light Sensor",
  temperature_sensor: "Temperature Sensor",
  humidity_sensor: "Humidity Sensor",
  pressure_sensor: "Pressure Sensor",
  flow_sensor: "Flow Sensor",
  on_off_plugin_unit: "On/Off Plug-in Unit",
  dimmable_plugin_unit: "Dimmable Plug-in Unit",
  door_lock: "Door Lock",
  window_covering: "Window Covering",
  thermostat: "Thermostat",
  fan: "Fan",
  air_quality_sensor: "Air Quality Sensor",
  generic_switch: "Generic Switch (Button)",
  speaker: "Speaker",
  robot_vacuum_cleaner: "Robot Vacuum Cleaner",
  humidifier_dehumidifier: "Humidifier/Dehumidifier",
  smoke_co_alarm: "Smoke/CO Alarm",
  water_leak_detector: "Water Leak Detector",
};

export const domainToDefaultMatterTypes: Partial<
  Record<HomeAssistantDomain, MatterDeviceType[]>
> = {
  light: [
    "on_off_light",
    "dimmable_light",
    "color_temperature_light",
    "extended_color_light",
  ],
  switch: ["on_off_plugin_unit", "on_off_switch"],
  input_boolean: ["on_off_plugin_unit", "on_off_switch"],
  lock: ["door_lock"],
  cover: ["window_covering"],
  climate: ["thermostat"],
  fan: ["fan"],
  binary_sensor: ["contact_sensor", "occupancy_sensor"],
  sensor: [
    "temperature_sensor",
    "humidity_sensor",
    "pressure_sensor",
    "light_sensor",
    "air_quality_sensor",
  ],
  button: ["generic_switch"],
  input_button: ["generic_switch"],
  automation: ["on_off_switch"],
  script: ["on_off_switch"],
  scene: ["on_off_switch"],
  media_player: ["speaker", "on_off_switch"],
  humidifier: ["humidifier_dehumidifier"],
  vacuum: ["robot_vacuum_cleaner"],
};
