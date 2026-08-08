import { Logger } from "@matter/general";
import type { MutableEndpoint } from "@matter/main";
import {
  AirQualitySensorDevice,
  ColorTemperatureLightDevice,
  ContactSensorDevice,
  DimmableLightDevice,
  DimmablePlugInUnitDevice,
  DoorLockDevice,
  ExtendedColorLightDevice,
  FanDevice,
  FlowSensorDevice,
  GenericSwitchDevice,
  HumiditySensorDevice,
  LightSensorDevice,
  OccupancySensorDevice,
  OnOffLightDevice,
  OnOffPlugInUnitDevice,
  PressureSensorDevice,
  TemperatureSensorDevice,
  ThermostatDevice,
  WaterLeakDetectorDevice,
  WindowCoveringDevice,
} from "@matter/main/devices";
import { IdentifyServer } from "../matter/behaviors/identify-server.js";
import { validateEndpointType } from "../matter/endpoints/validate-endpoint-type.js";
import { PluginBasicInformationServer } from "./plugin-basic-information-server.js";
import { PluginDeviceBehavior } from "./plugin-behavior.js";

const logger = Logger.get("PluginDeviceFactory");

/**
 * Maps plugin device type strings to Matter.js EndpointTypes.
 *
 * Each device type gets IdentifyServer, PluginBasicInformationServer, and
 * PluginDeviceBehavior attached. The plugin's command/attribute callbacks
 * are invoked via PluginDeviceBehavior when controllers interact.
 */
const deviceTypeMap: Record<string, () => MutableEndpoint> = {
  on_off_light: () =>
    OnOffLightDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  dimmable_light: () =>
    DimmableLightDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  color_temperature_light: () =>
    ColorTemperatureLightDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  extended_color_light: () =>
    ExtendedColorLightDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  on_off_plugin_unit: () =>
    OnOffPlugInUnitDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  dimmable_plug_in_unit: () =>
    DimmablePlugInUnitDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  temperature_sensor: () =>
    TemperatureSensorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  humidity_sensor: () =>
    HumiditySensorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  pressure_sensor: () =>
    PressureSensorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  flow_sensor: () =>
    FlowSensorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  light_sensor: () =>
    LightSensorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  occupancy_sensor: () =>
    OccupancySensorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  contact_sensor: () =>
    ContactSensorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  air_quality_sensor: () =>
    AirQualitySensorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  thermostat: () =>
    ThermostatDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  door_lock: () =>
    DoorLockDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  fan: () =>
    FanDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  window_covering: () =>
    WindowCoveringDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  generic_switch: () =>
    GenericSwitchDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
  water_leak_detector: () =>
    WaterLeakDetectorDevice.with(
      IdentifyServer,
      PluginBasicInformationServer,
      PluginDeviceBehavior,
    ),
};

/**
 * Create a Matter.js EndpointType for a plugin device type string.
 * Returns undefined if the device type is not supported.
 */
export function createPluginEndpointType(
  deviceType: string,
): MutableEndpoint | undefined {
  const factory = deviceTypeMap[deviceType];
  if (!factory) {
    logger.warn(`Unsupported plugin device type: "${deviceType}"`);
    return undefined;
  }
  const endpoint = factory();
  validateEndpointType(endpoint, `plugin:${deviceType}`);
  return endpoint;
}

/**
 * Get all supported plugin device type strings.
 */
export function getSupportedPluginDeviceTypes(): string[] {
  return Object.keys(deviceTypeMap);
}
