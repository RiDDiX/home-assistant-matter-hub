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
  | "electrical_meter"
  | "electrical_sensor"
  | "evse"
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
  | "mounted_on_off_control"
  | "ozone_sensor"
  | "pm1_sensor"
  | "pressure_sensor"
  | "pump"
  | "rain_sensor"
  | "radon_sensor"
  | "robot_vacuum_cleaner"
  | "robotic_lawn_mower"
  | "smoke_co_alarm"
  | "solar_power"
  | "speaker"
  | "temperature_sensor"
  | "thermostat"
  | "tvoc_sensor"
  | "water_heater"
  | "water_heater_management"
  | "water_freeze_detector"
  | "water_leak_detector"
  | "water_valve"
  | "window_covering";

export interface ComposedSubEntity {
  readonly entityId: string;
  readonly matterDeviceType?: MatterDeviceType;
}

export type ClimateAutoMode = "heat" | "cool";

export interface FanWindPresets {
  // HA preset names that mean natural wind (e.g. 自然风)
  readonly natural?: string[];
  // HA preset names that mean sleep wind
  readonly sleep?: string[];
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
   * Optional: Skip attaching a battery source to this entity, whether from a
   * same-device auto-mapped sensor or the entity's own battery/battery_level
   * attribute. Some integrations (e.g. Xiaomi Home) report a bogus battery
   * sensor on mains-powered devices, causing a false low-battery warning in
   * Matter controllers.
   * Default: false (battery mapping applies normally)
   */
  readonly disableBatteryMapping?: boolean;
  /**
   * Optional: Entity ID of a problem/safety binary sensor on the same device.
   * Drives hardwareFaultAlert on a smoke/CO alarm (#408).
   * Example: "binary_sensor.smoke_problem"
   */
  readonly faultEntity?: string;
  /**
   * Optional: Entity ID of a charging-state sensor for a vacuum, so the Matter
   * batChargeState comes from a dedicated sensor (e.g. Xiaomi charging_state)
   * instead of being inferred from docked + battery level (#377).
   * Example: "sensor.vacuum_charging_state"
   */
  readonly chargingStateEntity?: string;
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
   * Optional: HA service that programs a usercode on the physical lock when a
   * controller sets or clears the PIN credential, e.g.
   * zwave_js.set_lock_usercode or zha.set_lock_user_code. Opt-in, leave unset
   * to keep the PIN only in HAMH.
   */
  readonly lockUsercodeService?: string;
  /** Optional: physical code slot to program, default 1. */
  readonly lockUsercodeSlot?: number;
  /**
   * Optional: Override the advertised minimum PIN length (uint8, 1..20).
   * Some physical locks accept only an exact length; controllers enforce the
   * advertised bounds in their PIN UI. Default 4. Set min == max for a fixed
   * length (#418). Fixed attributes, controllers cache them until re-pair.
   */
  readonly lockPinMinLength?: number;
  /** Optional: Override the advertised maximum PIN length (uint8, 1..20). Default 8. */
  readonly lockPinMaxLength?: number;
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
   * Optional: Entity ID of a voltage sensor (device_class: voltage, unit: V).
   * Folds voltage into the ElectricalPowerMeasurement cluster of this device.
   * Example: "sensor.smart_plug_voltage"
   */
  readonly voltageEntity?: string;
  /**
   * Optional: Entity ID of a current sensor (device_class: current, unit: A).
   * Folds current into the ElectricalPowerMeasurement cluster of this device.
   * Example: "sensor.smart_plug_current"
   */
  readonly currentEntity?: string;
  /**
   * Optional: Entity ID of a power sensor (device_class: power, unit: W) for a
   * home battery, positive on discharge and negative on charge. Adds an
   * ElectricalPowerMeasurement to a BatteryStorage device; on the Matter side
   * charging shows as imported (positive) and discharging as exported (negative).
   * Example: "sensor.home_battery_power"
   */
  readonly batteryPowerEntity?: string;
  /**
   * Optional: Entity ID of an energy sensor (device_class: energy, unit: kWh)
   * for a home battery. Adds ElectricalEnergyMeasurement to a BatteryStorage
   * device to show lifetime throughput.
   * Example: "sensor.home_battery_energy"
   */
  readonly batteryEnergyEntity?: string;
  /**
   * Optional: Entity ID of a switch that starts and stops charging for an EVSE.
   * EnableCharging turns it on, Disable turns it off.
   * Example: "switch.wallbox_charging"
   */
  readonly chargingSwitchEntity?: string;
  /**
   * Optional: Entity ID of a number entity (amperes) that sets an EVSE's charge
   * current limit. EnableCharging writes the requested maximum here (clamped to
   * a sane range) and its live value feeds MaximumChargeCurrent.
   * Example: "number.wallbox_current_limit"
   */
  readonly currentLimitEntity?: string;
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
  /** Localized HA fan preset names that map to Matter wind modes (#387). */
  readonly fanWindPresets?: FanWindPresets;
  /** Restore the last fan speed when a controller turns the fan on, ignoring an injected value (Apple Home power button, #387). */
  readonly fanRestoreSpeedOnPowerOn?: boolean;
  /**
   * Optional: Entity ID of a sensor that reports the room the vacuum is currently in.
   * Used for Dreame vacuums (Tasshack integration) which expose sensor.*_current_room.
   * When configured, the vacuum's currentArea and progress are updated dynamically
   * as the vacuum moves between rooms during multi-room cleaning.
   * Example: "sensor.dreame_l10s_current_room"
   */
  readonly currentRoomEntity?: string;
  /**
   * Optional: Entity ID of a sensor reporting cumulative cleaned area in m2.
   * For batch vacuums that report total area but not the current room, the
   * cleaned area plus per-room sizeSqm advances currentArea/progress (#368).
   */
  readonly cleanedAreaEntity?: string;
  /**
   * Optional: Don't expose custom service areas as per-room RvcRunMode modes,
   * so Apple Home uses the ServiceArea multi-room picker instead of cleaning a
   * single room. Keep off for Google Home / Alexa, which use the modes (#367).
   */
  readonly disableCustomAreaRoomModes?: boolean;
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
   * Optional: expose this cover as a Dimmable Light instead of a WindowCovering.
   * Level maps to position (100% open), on/off to open/close. Alexa workaround,
   * it stopped sending cover position commands but still drives lights (#372).
   * No stop command, and don't put it in an Alexa room or "lights" commands move
   * it. Keep off for Apple/Google.
   */
  readonly coverExposeAsDimmableLight?: boolean;
  /**
   * Expose a select/input_select as an on/off switch. Controllers can't
   * render the Matter ModeSelect type (#356), this maps on/off to two
   * chosen options instead.
   */
  readonly selectExposeAsSwitch?: boolean;
  /** Option that the switch "on" selects and reports as on. */
  readonly selectSwitchOnOption?: string;
  /** Option that the switch "off" selects. */
  readonly selectSwitchOffOption?: string;
  /**
   * Optional: per-entity cover slider debounce (ms). Overrides the bridge
   * coverSliderDebounceMs flag. 0 / unset = fall back to bridge / default.
   */
  readonly coverSliderDebounceMs?: number;
  /**
   * Optional: throttle Matter updates for this entity to at most one per N ms.
   * Use for chatty sensors (power, energy) that change constantly and otherwise
   * push a Matter report on every tick. 0 / unset keeps the default behaviour.
   */
  readonly updateThrottleMs?: number;
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
   * Optional: Expose a second Matter Fan device alongside this climate AC,
   * bound to the same HA entity. Apple Home does not surface a thermostat
   * fan / fan_only mode, so this companion Fan tile turns the AC's fan_only
   * operation on and off via climate.set_hvac_mode and drives its speed via
   * climate.set_fan_mode. Off by default. Only takes effect when the climate
   * entity reports the FAN_MODE feature. Enabling re-registers this AC as a
   * composed device, which forces a one-time re-pair of this AC only.
   */
  readonly climateExposeFan?: boolean;
  /**
   * Optional: Pin single-setpoint HA auto climates (auto+heat+cool without
   * heat_cool) to a fixed Matter direction. Use this for IR / SmartIR ACs
   * where auto-detection flips between Heat and Cool. Unset keeps
   * auto-detection.
   */
  readonly climateAutoMode?: ClimateAutoMode;
  /**
   * Auto-populated at runtime when the vacuum supports HA 2026.3 CLEAN_AREA.
   * Maps HA areas (from the user's segment-to-area mapping in HA) to Matter
   * ServiceArea area IDs. When set, vacuum.clean_area is used instead of
   * vendor-specific room cleaning commands.
   */
  readonly cleanAreaRooms?: import("./domains/vacuum.js").CleanAreaRoom[];
  /**
   * Optional: Skip the optimistic on/off flip for momentary entities (script,
   * scene, automation, input_button, button). These normally report on, then
   * auto-reset to off about a second later, so controllers don't show a
   * stuck "on" state. Some Echo devices wedge on that unsolicited on->off
   * report pair until restarted (#423). When set, the state stays off and no
   * report is sent; the underlying HA action still fires.
   * Default: false (report the on/off flip normally)
   */
  readonly disableMomentaryFlip?: boolean;
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
   * area's service/target is used as the template. Matching data keys are
   * combined where possible (arrays are concatenated, primitive values are
   * joined with commas), and selection metadata is injected into data.
   * Default: false (sequential dispatch, compatible with Roborock).
   */
  readonly batchDispatch?: boolean;
  /**
   * Optional: approximate room floor area in m2. Used only to advance
   * currentArea/progress from a cumulative cleaned-area sensor (#368).
   */
  readonly sizeSqm?: number;
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
  readonly disableBatteryMapping?: boolean;
  readonly chargingStateEntity?: string;
  readonly roomEntities?: string[];
  readonly disableLockPin?: boolean;
  readonly lockUsercodeService?: string;
  readonly lockUsercodeSlot?: number;
  readonly lockPinMinLength?: number;
  readonly lockPinMaxLength?: number;
  readonly powerEntity?: string;
  readonly energyEntity?: string;
  readonly voltageEntity?: string;
  readonly currentEntity?: string;
  readonly batteryPowerEntity?: string;
  readonly batteryEnergyEntity?: string;
  readonly chargingSwitchEntity?: string;
  readonly currentLimitEntity?: string;
  readonly suctionLevelEntity?: string;
  readonly mopIntensityEntity?: string;
  readonly customServiceAreas?: CustomServiceArea[];
  readonly customFanSpeedTags?: Record<string, number>;
  /** Localized HA fan preset names that map to Matter wind modes (#387). */
  readonly fanWindPresets?: FanWindPresets;
  /** Restore the last fan speed when a controller turns the fan on, ignoring an injected value (Apple Home power button, #387). */
  readonly fanRestoreSpeedOnPowerOn?: boolean;
  readonly currentRoomEntity?: string;
  readonly cleanedAreaEntity?: string;
  readonly disableCustomAreaRoomModes?: boolean;
  readonly valetudoIdentifier?: string;
  readonly coverSwapOpenClose?: boolean;
  readonly coverExposeAsDimmableLight?: boolean;
  readonly selectExposeAsSwitch?: boolean;
  readonly selectSwitchOnOption?: string;
  readonly selectSwitchOffOption?: string;
  readonly coverSliderDebounceMs?: number;
  readonly updateThrottleMs?: number;
  readonly disableClimateOnOff?: boolean;
  readonly disableClimateFanControl?: boolean;
  readonly climateKeepModeOnIdle?: boolean;
  readonly climateExposeFan?: boolean;
  readonly climateAutoMode?: ClimateAutoMode;
  readonly composedEntities?: ComposedSubEntity[];
  readonly disableMomentaryFlip?: boolean;
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
  electrical_meter: "Electrical Meter (Power/Energy/Voltage/Current)",
  electrical_sensor: "Electrical Sensor (Solar Power, legacy)",
  evse: "EV Charger (EVSE)",
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
  mounted_on_off_control: "Mounted On/Off Control (experimental)",
  ozone_sensor: "Ozone (O\u2083) Sensor",
  pm1_sensor: "PM1 Sensor",
  pressure_sensor: "Pressure Sensor",
  pump: "Pump",
  rain_sensor: "Rain Sensor",
  radon_sensor: "Radon Sensor",
  robot_vacuum_cleaner: "Robot Vacuum Cleaner",
  robotic_lawn_mower: "Robotic Lawn Mower",
  smoke_co_alarm: "Smoke/CO Alarm",
  solar_power: "Solar Power (Generation)",
  speaker: "Speaker",
  temperature_sensor: "Temperature Sensor",
  thermostat: "Thermostat",
  tvoc_sensor: "TVOC / VOC Index Sensor",
  water_heater: "Water Heater",
  water_heater_management: "Water Heater with Boost (Matter 1.4)",
  water_freeze_detector: "Water Freeze Detector",
  water_leak_detector: "Water Leak Detector",
  water_valve: "Water Valve",
  window_covering: "Window Covering",
};

export type ControllerSupport = "yes" | "partial" | "no" | "unknown";

export interface MatterDeviceTypeControllerSupport {
  apple: ControllerSupport;
  google: ControllerSupport;
  alexa: ControllerSupport;
  aqara: ControllerSupport;
  note?: string;
}

/**
 * Which controllers actually surface each Matter device type, so the override
 * picker can warn before you pick a type your controller ignores. Apple, Google
 * and Alexa verified 2026-06 against their device-support pages; Aqara from its
 * own Matter device list (aqara.com/en/explore/everything-matter, 2026-06), with
 * "unknown" where Aqara does not name the type. Controllers move fast, so treat
 * this as a point-in-time snapshot.
 */
export const matterDeviceTypeControllerSupport: Record<
  MatterDeviceType,
  MatterDeviceTypeControllerSupport
> = {
  on_off_light: { apple: "yes", google: "yes", alexa: "yes", aqara: "yes" },
  dimmable_light: { apple: "yes", google: "yes", alexa: "yes", aqara: "yes" },
  color_temperature_light: {
    apple: "yes",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
  },
  extended_color_light: {
    apple: "yes",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
  },
  on_off_plugin_unit: {
    apple: "yes",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
  },
  dimmable_plugin_unit: {
    apple: "yes",
    google: "no",
    alexa: "yes",
    aqara: "yes",
  },
  on_off_switch: {
    apple: "yes",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
  },
  mounted_on_off_control: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "Experimental Matter 1.4 type (0x010F). SmartThings and Aqara show it as a switch. Apple, Google and Alexa don't know it yet and are expected to fall back to the advertised plug subset, not verified on real devices (#380).",
  },
  door_lock: { apple: "yes", google: "partial", alexa: "yes", aqara: "yes" },
  window_covering: { apple: "yes", google: "yes", alexa: "yes", aqara: "yes" },
  thermostat: { apple: "yes", google: "yes", alexa: "yes", aqara: "yes" },
  fan: {
    apple: "no",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
    note: "Apple Home has no standalone fan, it only shows fans inside an AC.",
  },
  air_purifier: {
    apple: "no",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
    note: "Apple Home does not list air purifiers.",
  },
  robot_vacuum_cleaner: {
    apple: "yes",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
  },
  robotic_lawn_mower: {
    apple: "yes",
    google: "unknown",
    alexa: "yes",
    aqara: "unknown",
    note: "Shows up as a robot vacuum, there is no Matter mower type yet.",
  },
  humidifier_dehumidifier: {
    apple: "unknown",
    google: "no",
    alexa: "yes",
    aqara: "unknown",
  },
  dishwasher: {
    apple: "no",
    google: "no",
    alexa: "unknown",
    aqara: "unknown",
    note: "Appliance types have little controller support today.",
  },
  speaker: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    note: "Apple and Alexa do not show Matter speakers.",
  },
  basic_video_player: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "TV/media types only show in Aqara Home here.",
  },
  temperature_sensor: {
    apple: "yes",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
  },
  humidity_sensor: { apple: "yes", google: "yes", alexa: "yes", aqara: "yes" },
  light_sensor: { apple: "yes", google: "yes", alexa: "yes", aqara: "unknown" },
  pressure_sensor: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    note: "Google Home and Aqara show pressure sensors.",
  },
  flow_sensor: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "unknown",
    note: "Only Google Home shows flow sensors.",
  },
  air_quality_sensor: {
    apple: "no",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
    note: "Apple Home does not show air quality.",
  },
  tvoc_sensor: { apple: "no", google: "no", alexa: "partial", aqara: "yes" },
  carbon_monoxide_sensor: {
    apple: "partial",
    google: "no",
    alexa: "partial",
    aqara: "yes",
    note: "Apple shows a CO alarm, not a CO level reading.",
  },
  nitrogen_dioxide_sensor: {
    apple: "no",
    google: "no",
    alexa: "partial",
    aqara: "yes",
  },
  ozone_sensor: { apple: "no", google: "no", alexa: "partial", aqara: "yes" },
  formaldehyde_sensor: {
    apple: "no",
    google: "no",
    alexa: "partial",
    aqara: "yes",
  },
  radon_sensor: { apple: "no", google: "no", alexa: "partial", aqara: "yes" },
  pm1_sensor: { apple: "no", google: "no", alexa: "partial", aqara: "yes" },
  electrical_meter: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "unknown",
    note: "Google Home and SmartThings show an ElectricalMeter (0x0514); Apple and Alexa do not surface standalone power/energy.",
  },
  electrical_sensor: {
    apple: "no",
    google: "no",
    alexa: "unknown",
    aqara: "unknown",
    note: "Legacy SolarPower (0x0017) alias. Google does not list it; pick Electrical Meter for consumption.",
  },
  solar_power: {
    apple: "no",
    google: "no",
    alexa: "unknown",
    aqara: "unknown",
    note: "SolarPower (0x0017) for generation. Only SmartThings renders it standalone today.",
  },
  battery_storage: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "Aqara lists battery storage; others show battery inside a device.",
  },
  evse: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "HA and Aqara render EnergyEvse; SmartThings announced support, unconfirmed. Bridged EVSE can break Alexa device recognition, keep it off Alexa bridges.",
  },
  contact_sensor: { apple: "yes", google: "yes", alexa: "yes", aqara: "yes" },
  motion_sensor: { apple: "yes", google: "yes", alexa: "yes", aqara: "yes" },
  occupancy_sensor: {
    apple: "partial",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
  },
  mode_select: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "unknown",
    note: "Google Home does not support Mode Select (issue #356).",
  },
  water_valve: { apple: "no", google: "no", alexa: "no", aqara: "yes" },
  pump: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    note: "Google Home and Aqara show pumps.",
  },
  rain_sensor: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "Newer Matter detector type with thin support, Alexa may reject it (issue #365).",
  },
  water_freeze_detector: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "Newer Matter detector type with thin support, Alexa may reject it (issue #365).",
  },
  water_leak_detector: {
    apple: "yes",
    google: "no",
    alexa: "yes",
    aqara: "yes",
    note: "Apple added leak sensors in iOS 18.4.",
  },
  water_heater: { apple: "no", google: "no", alexa: "unknown", aqara: "yes" },
  water_heater_management: {
    apple: "no",
    google: "no",
    alexa: "unknown",
    aqara: "unknown",
    note: "Matter 1.4 Water Heater (0x050F) with WaterHeaterManagement Boost/CancelBoost. Energy-management controllers only, no mainstream controller renders it yet.",
  },
  generic_switch: {
    apple: "partial",
    google: "no",
    alexa: "yes",
    aqara: "unknown",
    note: "Best for stateless buttons.",
  },
  smoke_co_alarm: {
    apple: "yes",
    google: "no",
    alexa: "yes",
    aqara: "yes",
    note: "Apple added smoke/CO alarms in iOS 18.4.",
  },
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
  input_boolean: [
    "on_off_plugin_unit",
    "on_off_switch",
    "mounted_on_off_control",
  ],
  input_select: ["mode_select"],
  lawn_mower: ["robotic_lawn_mower"],
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
    "electrical_meter",
    "electrical_sensor",
    "evse",
    "formaldehyde_sensor",
    "humidity_sensor",
    "light_sensor",
    "nitrogen_dioxide_sensor",
    "ozone_sensor",
    "pm1_sensor",
    "pressure_sensor",
    "radon_sensor",
    "solar_power",
    "temperature_sensor",
    "tvoc_sensor",
  ],
  select: ["mode_select"],
  siren: ["on_off_plugin_unit"],
  switch: [
    "dishwasher",
    "evse",
    "on_off_plugin_unit",
    "on_off_switch",
    "mounted_on_off_control",
    "pump",
    "water_valve",
  ],
  vacuum: ["robot_vacuum_cleaner"],
  valve: ["water_valve", "on_off_plugin_unit"],
  water_heater: ["water_heater", "water_heater_management", "thermostat"],
};
