import type { HomeAssistantDomain } from "./home-assistant-domain.js";

export type MatterDeviceType =
  | "air_purifier"
  | "air_quality_sensor"
  | "dishwasher"
  | "basic_video_player"
  | "battery_storage"
  | "carbon_monoxide_sensor"
  | "color_temperature_light"
  | "contact_sensor"
  | "dimmable_light"
  | "dimmable_plugin_unit"
  | "door_lock"
  | "electrical_sensor"
  | "extended_color_light"
  | "fan"
  | "flow_sensor"
  | "formaldehyde_sensor"
  | "generic_switch"
  | "humidifier_dehumidifier"
  | "humidity_sensor"
  | "light_sensor"
  | "mode_select"
  | "motion_sensor"
  | "nitrogen_dioxide_sensor"
  | "occupancy_sensor"
  | "on_off_light"
  | "on_off_plugin_unit"
  | "on_off_switch"
  | "ozone_sensor"
  | "pm1_sensor"
  | "pressure_sensor"
  | "pump"
  | "rain_sensor"
  | "radon_sensor"
  | "robot_vacuum_cleaner"
  | "smoke_co_alarm"
  | "speaker"
  | "temperature_sensor"
  | "thermostat"
  | "tvoc_sensor"
  | "water_heater"
  | "water_freeze_detector"
  | "water_leak_detector"
  | "water_valve"
  | "window_covering";

export interface ComposedSubEntity {
  readonly entityId: string;
  readonly matterDeviceType?: MatterDeviceType;
}

export interface EntityMappingConfig {
  readonly entityId: string;
  readonly matterDeviceType?: MatterDeviceType;
  readonly customName?: string;
  /**
   * Optional: Override the productName reported to Matter controllers.
   * Some controllers (e.g. Aqara) display productName as the device name
   * instead of nodeLabel. When set, this takes priority over the HA device
   * registry model/model_id values.
   */
  readonly customProductName?: string;
  /**
   * Optional: Override the vendorName reported to Matter controllers.
   * When set, this takes priority over the HA device registry manufacturer.
   */
  readonly customVendorName?: string;
  /**
   * Optional: Override the serialNumber reported to Matter controllers.
   * When set, this takes priority over the default entity-ID-based hash.
   */
  readonly customSerialNumber?: string;
  /**
   * Optional: Override the numeric Matter Vendor ID for this entity.
   * Range 1..0xFFFE. Some controllers (Aqara) key vendor-specific UI off
   * the numeric vendorId rather than vendorName. Bridge mode only: in
   * server mode the root vendorId is fixed at commissioning time and
   * cannot be changed without breaking already-paired controllers.
   */
  readonly customVendorId?: number;
  readonly disabled?: boolean;
  /**
   * Optional: Array of additional entities to compose into this device.
   * Each entry becomes a sub-endpoint under a shared BridgedNodeEndpoint.
   * Requires the autoComposedDevices feature flag.
   * Example: [{ entityId: "sensor.temperature", matterDeviceType: "temperature_sensor" }]
   */
  readonly composedEntities?: ComposedSubEntity[];
  /**
   * Optional: Entity ID of a sensor that provides filter life percentage (0-100).
   * Used for Air Purifiers to show HEPA filter life in Matter controllers.
   * Example: "sensor.luftreiniger_filter_life"
   */
  readonly filterLifeEntity?: string;
  /**
   * Optional: Entity ID of a select entity that controls the vacuum cleaning mode.
   * Used for Dreame vacuums where the cleaning mode is controlled via a separate select entity.
   * If not specified, it will be derived from the vacuum entity ID (e.g., vacuum.r2d2 -> select.r2d2_cleaning_mode).
   * Example: "select.r2_d2_cleaning_mode"
   */
  readonly cleaningModeEntity?: string;
  /**
   * Optional: Entity ID of a temperature sensor to combine with a fan or air purifier.
   * Adds TemperatureMeasurement cluster to the air purifier in Matter controllers.
   * Example: "sensor.air_purifier_temperature"
   */
  readonly temperatureEntity?: string;
  /**
   * Optional: Entity ID of a humidity sensor to combine with a temperature sensor
   * or a fan/air purifier. Creates a combined device in Matter controllers.
   * Example: "sensor.h_t_bad_humidity"
   */
  readonly humidityEntity?: string;
  /**
   * Optional: Entity ID of a pressure sensor to combine with a temperature sensor.
   * Creates a combined Temperature+Pressure sensor in Matter instead of separate devices.
   * Example: "sensor.h_t_bad_pressure"
   */
  readonly pressureEntity?: string;
  /**
   * Optional: Entity ID of a battery sensor to include with any sensor.
   * Adds PowerSource cluster to show battery level in Matter controllers.
   * Example: "sensor.h_t_bad_battery"
   */
  readonly batteryEntity?: string;
  /**
   * Optional: Array of button entity IDs for room-based cleaning (Roborock, etc.).
   * Each button entity represents a room/scene in the vacuum app.
   * When a room is selected via Matter, the corresponding button will be pressed.
   * Example: ["button.roborock_clean_kitchen", "button.roborock_clean_living_room"]
   */
  readonly roomEntities?: string[];
  /**
   * Optional: Disable PIN requirement for this lock.
   * When true, the lock will not require PIN validation even if a PIN is configured.
   * Useful when you have multiple locks and only want PIN protection on some of them.
   * Default: false (PIN is required if configured)
   */
  readonly disableLockPin?: boolean;
  /**
   * Optional: Entity ID of a power sensor (device_class: power, unit: W).
   * Adds ElectricalPowerMeasurement cluster to show real-time power consumption.
   * Example: "sensor.smart_plug_power"
   */
  readonly powerEntity?: string;
  /**
   * Optional: Entity ID of an energy sensor (device_class: energy, unit: kWh).
   * Adds ElectricalEnergyMeasurement cluster to show cumulative energy consumption.
   * Example: "sensor.smart_plug_energy"
   */
  readonly energyEntity?: string;
  /**
   * Optional: Entity ID of a select entity that controls the vacuum suction level.
   * Used for Dreame/Roborock vacuums where suction level is a separate select entity.
   * When configured, intensity variants (Quiet/Max) are added to each cleaning mode,
   * enabling Apple Home's "extra features" panel for all cleaning modes.
   * Example: "select.r2_d2_suction_level"
   */
  readonly suctionLevelEntity?: string;
  /**
   * Optional: Entity ID of a select entity that controls the vacuum mop intensity / water level.
   * Used for Dreame/Ecovacs vacuums where mop intensity is a separate select entity.
   * When configured, intensity variants are added to the Mop cleaning mode,
   * enabling Apple Home's "extra features" panel when mopping.
   * Example: "select.r2_d2_mop_pad_humidity"
   */
  readonly mopIntensityEntity?: string;
  /**
   * Optional: Array of custom service area definitions for zone-based robots.
   * Each entry defines a named area mapped to a Home Assistant service call.
   * When the area is selected via Matter ServiceArea and cleaning starts,
   * the configured service is called with the provided data.
   * Works for any zone-based robot (vacuums, lawn mowers, pool cleaners, etc.).
   * Example: [{ name: "Front Yard", service: "script.mow_front_yard", data: { zone: 1 } }]
   */
  readonly customServiceAreas?: CustomServiceArea[];
  /**
   * Optional: Map custom fan speed / suction level options to Matter intensity tags.
   * Key is the Home Assistant option string ("low", "medium" etc.).
   * Value is the Matter ModeTag.
   */
  readonly customFanSpeedTags?: Record<string, number>;
  /**
   * Optional: Entity ID of a sensor that reports the room the vacuum is currently in.
   * Used for Dreame vacuums (Tasshack integration) which expose sensor.*_current_room.
   * When configured, the vacuum's currentArea and progress are updated dynamically
   * as the vacuum moves between rooms during multi-room cleaning.
   * Example: "sensor.dreame_l10s_current_room"
   */
  readonly currentRoomEntity?: string;
  /**
   * Optional: Valetudo MQTT identifier for segment cleaning.
   * HA lowercases entity IDs, but the MQTT topic needs the exact identifier
   * shown in Valetudo under Connectivity → MQTT (e.g., "GentleFinishedSpider").
   * If not set, the identifier is extracted from the entity ID (all lowercase).
   */
  readonly valetudoIdentifier?: string;
  /**
   * Optional: Swap open/close commands for this individual cover entity.
   * Useful for awnings where HA "open" means extending outward but Matter
   * controllers interpret "open" as going up. Overrides the bridge-level
   * coverSwapOpenClose feature flag for this entity only.
   */
  readonly coverSwapOpenClose?: boolean;
  /**
   * Optional: per-entity cover slider debounce (ms). Overrides the bridge
   * coverSliderDebounceMs flag. 0 / unset = fall back to bridge / default.
   */
  readonly coverSliderDebounceMs?: number;
  /**
   * Optional: Skip the Matter OnOff cluster for this climate entity.
   * Stops voice commands like "turn off <room>" from calling
   * climate.turn_off on the thermostat. No effect on non-climate entities.
   */
  readonly disableClimateOnOff?: boolean;
  /**
   * Optional: Skip the Matter FanControl cluster for this climate entity, and
   * expose it as ThermostatDevice instead of RoomAirConditionerDevice. Use
   * this when a controller (e.g. Aqara) does not recognise the
   * RoomAirConditioner device type and silently drops the endpoint. Fan
   * modes are no longer exposed over Matter, but stay controllable in HA.
   */
  readonly disableClimateFanControl?: boolean;
  /**
   * Optional: While the climate entity is off + hvac_action=idle (e.g. an AC
   * running an internal cleaning cycle after power-off), keep reporting the
   * last known operating mode on the Matter side instead of switching to Off.
   * Lets the Matter controller's Off button stay actionable so the cleaning
   * cycle can be cancelled. HA and Matter intentionally diverge until the
   * entity reports a real mode again.
   */
  readonly climateKeepModeOnIdle?: boolean;
  /**
   * Auto-populated at runtime when the vacuum supports HA 2026.3 CLEAN_AREA.
   * Maps HA areas (from the user's segment-to-area mapping in HA) to Matter
   * ServiceArea area IDs. When set, vacuum.clean_area is used instead of
   * vendor-specific room cleaning commands.
   */
  readonly cleanAreaRooms?: import("./domains/vacuum.js").CleanAreaRoom[];
}

export interface CustomServiceArea {
  /** Display name shown in Apple Home / Matter controllers */
  readonly name: string;
  /** Home Assistant service to call (e.g., "script.start_zone", "button.press") */
  readonly service: string;
  /** Optional: Target entity for the service call (defaults to the vacuum entity) */
  readonly target?: string;
  /** Optional: Additional data to pass to the service call */
  readonly data?: Record<string, unknown>;
  /**
   * Optional: Fire a single combined call for all selected areas instead of
   * one call per area. Set on any area in the selection; the first matched
   * area's service/target/data is used as the template and three extra keys
   * are injected: selected_area_names (string[]), selected_area_ids_csv
   * (string), and selected_area_data (Record<string, unknown>[]). Default:
   * false (sequential dispatch, compatible with Roborock).
   */
  readonly batchDispatch?: boolean;
}

export interface EntityMappingRequest {
  readonly bridgeId: string;
  readonly entityId: string;
  readonly matterDeviceType?: MatterDeviceType;
  readonly customName?: string;
  readonly customProductName?: string;
  readonly customVendorName?: string;
  readonly customSerialNumber?: string;
  readonly customVendorId?: number;
  readonly disabled?: boolean;
  readonly filterLifeEntity?: string;
  readonly cleaningModeEntity?: string;
  readonly temperatureEntity?: string;
  readonly humidityEntity?: string;
  readonly pressureEntity?: string;
  readonly batteryEntity?: string;
  readonly roomEntities?: string[];
  readonly disableLockPin?: boolean;
  readonly powerEntity?: string;
  readonly energyEntity?: string;
  readonly suctionLevelEntity?: string;
  readonly mopIntensityEntity?: string;
  readonly customServiceAreas?: CustomServiceArea[];
  readonly customFanSpeedTags?: Record<string, number>;
  readonly currentRoomEntity?: string;
  readonly valetudoIdentifier?: string;
  readonly coverSwapOpenClose?: boolean;
  readonly coverSliderDebounceMs?: number;
  readonly disableClimateOnOff?: boolean;
  readonly disableClimateFanControl?: boolean;
  readonly climateKeepModeOnIdle?: boolean;
  readonly composedEntities?: ComposedSubEntity[];
}

export interface EntityMappingResponse {
  readonly bridgeId: string;
  readonly mappings: EntityMappingConfig[];
}

export const matterDeviceTypeLabels: Record<MatterDeviceType, string> = {
  air_purifier: "Air Purifier",
  air_quality_sensor: "Air Quality Sensor",
  basic_video_player: "Basic Video Player (TV)",
  battery_storage: "Battery Sensor",
  carbon_monoxide_sensor: "Carbon Monoxide (CO) Sensor",
  color_temperature_light: "Color Temperature Light",
  contact_sensor: "Contact Sensor",
  dishwasher: "Dishwasher",
  dimmable_light: "Dimmable Light",
  dimmable_plugin_unit: "Dimmable Plug-in Unit",
  door_lock: "Door Lock",
  electrical_sensor: "Electrical Sensor (Power/Energy/Voltage/Current)",
  extended_color_light: "Extended Color Light",
  fan: "Fan",
  flow_sensor: "Flow Sensor",
  formaldehyde_sensor: "Formaldehyde (HCHO) Sensor",
  generic_switch: "Generic Switch (Button)",
  humidifier_dehumidifier: "Humidifier/Dehumidifier",
  humidity_sensor: "Humidity Sensor",
  light_sensor: "Light Sensor",
  mode_select: "Mode Select",
  motion_sensor: "Motion Sensor (PIR)",
  nitrogen_dioxide_sensor: "Nitrogen Dioxide (NO\u2082) Sensor",
  occupancy_sensor: "Occupancy Sensor",
  on_off_light: "On/Off Light",
  on_off_plugin_unit: "On/Off Plug-in Unit",
  on_off_switch: "On/Off Switch",
  ozone_sensor: "Ozone (O\u2083) Sensor",
  pm1_sensor: "PM1 Sensor",
  pressure_sensor: "Pressure Sensor",
  pump: "Pump",
  rain_sensor: "Rain Sensor",
  radon_sensor: "Radon Sensor",
  robot_vacuum_cleaner: "Robot Vacuum Cleaner",
  smoke_co_alarm: "Smoke/CO Alarm",
  speaker: "Speaker",
  temperature_sensor: "Temperature Sensor",
  thermostat: "Thermostat",
  tvoc_sensor: "TVOC / VOC Index Sensor",
  water_heater: "Water Heater",
  water_freeze_detector: "Water Freeze Detector",
  water_leak_detector: "Water Leak Detector",
  water_valve: "Water Valve",
  window_covering: "Window Covering",
};

/**
 * RVC Clean Mode ModeTag values from the Matter spec (v1.4.2 § 7.3.7.2).
 * Mirrors @matter/types RvcCleanMode.ModeTag so the frontend doesn't need
 * the full Matter.js dependency.
 */
export const RvcCleanModeModeTag = {
  Auto: 0,
  Quick: 1,
  Quiet: 2,
  LowNoise: 3,
  LowEnergy: 4,
  Vacation: 5,
  Min: 6,
  Max: 7,
  Night: 8,
  Day: 9,
  DeepClean: 16384,
  Vacuum: 16385,
  Mop: 16386,
  VacuumThenMop: 16387,
} as const;

export const domainToDefaultMatterTypes: Partial<
  Record<HomeAssistantDomain, MatterDeviceType[]>
> = {
  alarm_control_panel: ["mode_select", "on_off_plugin_unit"],
  automation: ["on_off_switch"],
  binary_sensor: [
    "contact_sensor",
    "motion_sensor",
    "occupancy_sensor",
    "rain_sensor",
    "smoke_co_alarm",
    "water_freeze_detector",
    "water_leak_detector",
  ],
  button: ["generic_switch"],
  climate: ["thermostat"],
  cover: ["window_covering"],
  event: ["generic_switch"],
  fan: ["air_purifier", "fan"],
  humidifier: ["humidifier_dehumidifier"],
  input_boolean: ["on_off_plugin_unit", "on_off_switch"],
  input_select: ["mode_select"],
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
    "battery_storage",
    "carbon_monoxide_sensor",
    "electrical_sensor",
    "formaldehyde_sensor",
    "humidity_sensor",
    "light_sensor",
    "nitrogen_dioxide_sensor",
    "ozone_sensor",
    "pm1_sensor",
    "pressure_sensor",
    "radon_sensor",
    "temperature_sensor",
    "tvoc_sensor",
  ],
  select: ["mode_select"],
  siren: ["on_off_plugin_unit"],
  switch: [
    "dishwasher",
    "on_off_plugin_unit",
    "on_off_switch",
    "pump",
    "water_valve",
  ],
  vacuum: ["robot_vacuum_cleaner"],
  valve: ["water_valve", "on_off_plugin_unit"],
  water_heater: ["water_heater", "thermostat"],
};
