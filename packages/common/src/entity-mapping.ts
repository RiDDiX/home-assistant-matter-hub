import type { HomeAssistantDomain } from "./home-assistant-domain.js";

export type MatterDeviceType =
  | "air_purifier"
  | "air_quality_sensor"
  | "basic_video_player"
  | "color_dimmer_switch"
  | "color_temperature_light"
  | "contact_sensor"
  | "dimmable_light"
  | "dimmable_plugin_unit"
  | "dimmer_switch"
  | "door_lock"
  | "extended_color_light"
  | "fan"
  | "flow_sensor"
  | "generic_switch"
  | "humidifier_dehumidifier"
  | "humidity_sensor"
  | "light_sensor"
  | "occupancy_sensor"
  | "on_off_light"
  | "on_off_plugin_unit"
  | "on_off_switch"
  | "pressure_sensor"
  | "robot_vacuum_cleaner"
  | "smoke_co_alarm"
  | "speaker"
  | "temperature_sensor"
  | "thermostat"
  | "water_leak_detector"
  | "window_covering";

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
  air_purifier: "Air Purifier",
  air_quality_sensor: "Air Quality Sensor",
  basic_video_player: "Basic Video Player (TV)",
  color_dimmer_switch: "Color Dimmer Switch",
  color_temperature_light: "Color Temperature Light",
  contact_sensor: "Contact Sensor",
  dimmable_light: "Dimmable Light",
  dimmable_plugin_unit: "Dimmable Plug-in Unit",
  dimmer_switch: "Dimmer Switch",
  door_lock: "Door Lock",
  extended_color_light: "Extended Color Light",
  fan: "Fan",
  flow_sensor: "Flow Sensor",
  generic_switch: "Generic Switch (Button)",
  humidifier_dehumidifier: "Humidifier/Dehumidifier",
  humidity_sensor: "Humidity Sensor",
  light_sensor: "Light Sensor",
  occupancy_sensor: "Occupancy Sensor",
  on_off_light: "On/Off Light",
  on_off_plugin_unit: "On/Off Plug-in Unit",
  on_off_switch: "On/Off Switch",
  pressure_sensor: "Pressure Sensor",
  robot_vacuum_cleaner: "Robot Vacuum Cleaner",
  smoke_co_alarm: "Smoke/CO Alarm",
  speaker: "Speaker",
  temperature_sensor: "Temperature Sensor",
  thermostat: "Thermostat",
  water_leak_detector: "Water Leak Detector",
  window_covering: "Window Covering",
};

export const domainToDefaultMatterTypes: Partial<
  Record<HomeAssistantDomain, MatterDeviceType[]>
> = {
  automation: ["on_off_switch"],
  binary_sensor: ["contact_sensor", "occupancy_sensor"],
  button: ["generic_switch"],
  climate: ["thermostat"],
  cover: ["window_covering"],
  fan: ["air_purifier", "fan"],
  humidifier: ["humidifier_dehumidifier"],
  input_boolean: ["on_off_plugin_unit", "on_off_switch"],
  input_button: ["generic_switch"],
  light: [
    "color_temperature_light",
    "dimmable_light",
    "extended_color_light",
    "on_off_light",
  ],
  lock: ["door_lock"],
  media_player: ["basic_video_player", "on_off_switch", "speaker"],
  scene: ["on_off_switch"],
  script: ["on_off_switch"],
  sensor: [
    "air_quality_sensor",
    "humidity_sensor",
    "light_sensor",
    "pressure_sensor",
    "temperature_sensor",
  ],
  switch: ["on_off_plugin_unit", "on_off_switch"],
  vacuum: ["robot_vacuum_cleaner"],
};
