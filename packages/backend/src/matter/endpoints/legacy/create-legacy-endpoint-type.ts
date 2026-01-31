import type {
  EntityMappingConfig,
  HomeAssistantDomain,
  HomeAssistantEntityInformation,
  MatterDeviceType,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import type { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { AirPurifierEndpoint } from "./air-purifier/index.js";
import { AlarmControlPanelDevice } from "./alarm-control-panel/index.js";
import { AutomationDevice } from "./automation/index.js";
import { BinarySensorDevice } from "./binary-sensor/index.js";
import { ButtonDevice } from "./button/index.js";
import { ClimateDevice } from "./climate/index.js";
import { CoverDevice } from "./cover/index.js";
import { FanDevice } from "./fan/index.js";
import { HumidifierDevice } from "./humidifier/index.js";
import { InputButtonDevice } from "./input-button/index.js";
import { ColorTemperatureLightType } from "./light/devices/color-temperature-light.js";
import { DimmableLightType } from "./light/devices/dimmable-light.js";
import { ExtendedColorLightType } from "./light/devices/extended-color-light.js";
import { OnOffLightType } from "./light/devices/on-off-light-device.js";
import { LightDevice } from "./light/index.js";
import { LockDevice } from "./lock/index.js";
import { VideoPlayerDevice } from "./media-player/basic-video-player.js";
import { MediaPlayerDevice } from "./media-player/index.js";
import { RemoteDevice } from "./remote/index.js";
import { SceneDevice } from "./scene/index.js";
import { ScriptDevice } from "./script/index.js";
import { AirQualitySensorType } from "./sensor/devices/air-quality-sensor.js";
import { FlowSensorType } from "./sensor/devices/flow-sensor.js";
import { HumiditySensorType } from "./sensor/devices/humidity-sensor.js";
import { IlluminanceSensorType } from "./sensor/devices/illuminance-sensor.js";
import { PressureSensorType } from "./sensor/devices/pressure-sensor.js";
import { TemperatureSensorType } from "./sensor/devices/temperature-sensor.js";
import { SensorDevice } from "./sensor/index.js";
import { SwitchDevice } from "./switch/index.js";
import { VacuumDevice } from "./vacuum/index.js";
import { ValveDevice } from "./valve/index.js";
import { WaterHeaterDevice } from "./water-heater/index.js";

/**
 * @deprecated
 */
export function createLegacyEndpointType(
  entity: HomeAssistantEntityInformation,
  mapping?: EntityMappingConfig,
): EndpointType | undefined {
  const domain = entity.entity_id.split(".")[0] as HomeAssistantDomain;
  const customName = mapping?.customName;

  if (mapping?.matterDeviceType) {
    const overrideFactory = matterDeviceTypeFactories[mapping.matterDeviceType];
    if (overrideFactory) {
      return overrideFactory({ entity, customName });
    }
  }

  const factory = deviceCtrs[domain];
  if (!factory) {
    return undefined;
  }
  return factory({ entity, customName });
}

const deviceCtrs: Partial<
  Record<
    HomeAssistantDomain,
    (
      homeAssistant: HomeAssistantEntityBehavior.State,
    ) => EndpointType | undefined
  >
> = {
  light: LightDevice,
  switch: SwitchDevice,
  lock: LockDevice,
  fan: FanDevice,
  binary_sensor: BinarySensorDevice,
  sensor: SensorDevice,
  cover: CoverDevice,
  climate: ClimateDevice,
  input_boolean: SwitchDevice,
  input_button: InputButtonDevice,
  button: ButtonDevice,
  automation: AutomationDevice,
  script: ScriptDevice,
  scene: SceneDevice,
  media_player: MediaPlayerDevice,
  humidifier: HumidifierDevice,
  vacuum: VacuumDevice,
  valve: ValveDevice,
  alarm_control_panel: AlarmControlPanelDevice,
  remote: RemoteDevice,
  water_heater: WaterHeaterDevice,
};

const matterDeviceTypeFactories: Partial<
  Record<
    MatterDeviceType,
    (
      homeAssistant: HomeAssistantEntityBehavior.State,
    ) => EndpointType | undefined
  >
> = {
  on_off_light: (ha) =>
    OnOffLightType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  dimmable_light: (ha) =>
    DimmableLightType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  color_temperature_light: (ha) =>
    ColorTemperatureLightType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  extended_color_light: (ha) =>
    ExtendedColorLightType(true).set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  on_off_plugin_unit: SwitchDevice,
  on_off_switch: SwitchDevice,
  door_lock: LockDevice,
  window_covering: CoverDevice,
  thermostat: ClimateDevice,
  fan: FanDevice,
  air_purifier: AirPurifierEndpoint,
  robot_vacuum_cleaner: VacuumDevice,
  humidifier_dehumidifier: HumidifierDevice,
  speaker: MediaPlayerDevice,
  basic_video_player: VideoPlayerDevice,
  humidity_sensor: (ha) =>
    HumiditySensorType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  temperature_sensor: (ha) =>
    TemperatureSensorType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  pressure_sensor: (ha) =>
    PressureSensorType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  light_sensor: (ha) =>
    IlluminanceSensorType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  flow_sensor: (ha) =>
    FlowSensorType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
  air_quality_sensor: (ha) =>
    AirQualitySensorType.set({
      homeAssistantEntity: { entity: ha.entity, customName: ha.customName },
    }),
};
