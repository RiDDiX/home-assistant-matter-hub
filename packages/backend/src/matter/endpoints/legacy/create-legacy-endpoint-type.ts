import type {
  EntityMappingConfig,
  HomeAssistantDomain,
  HomeAssistantEntityInformation,
  MatterDeviceType,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import { FixedLabelServer } from "@matter/main/behaviors";
import type { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { validateEndpointType } from "../validate-endpoint-type.js";
import { AirPurifierEndpoint } from "./air-purifier/index.js";
import {
  AlarmControlPanelDevice,
  AlarmOnOffDevice,
} from "./alarm-control-panel/index.js";
import { AutomationDevice } from "./automation/index.js";
import { ContactSensorType } from "./binary-sensor/contact-sensor.js";
import { BinarySensorDevice } from "./binary-sensor/index.js";
import { MotionSensorType } from "./binary-sensor/motion-sensor.js";
import { OccupancySensorType } from "./binary-sensor/occupancy-sensor.js";
import { RainSensorType } from "./binary-sensor/rain-sensor.js";
import { SmokeAlarmType } from "./binary-sensor/smoke-co-alarm.js";
import { WaterFreezeDetectorType } from "./binary-sensor/water-freeze-detector.js";
import { WaterLeakDetectorType } from "./binary-sensor/water-leak-detector.js";
import { ButtonDevice } from "./button/index.js";
import { ClimateDevice } from "./climate/index.js";
import { CoverDevice } from "./cover/index.js";
import { DishwasherEndpoint } from "./dishwasher/index.js";
import { EventDevice } from "./event/index.js";
import { FanDevice } from "./fan/index.js";
import { HumidifierDevice } from "./humidifier/index.js";
import { InputButtonDevice } from "./input-button/index.js";
import { LawnMowerDevice } from "./lawn-mower/index.js";
import { ColorTemperatureLightType } from "./light/devices/color-temperature-light.js";
import { DimmableLightType } from "./light/devices/dimmable-light.js";
import { ExtendedColorLightType } from "./light/devices/extended-color-light.js";
import { OnOffLightType } from "./light/devices/on-off-light-device.js";
import { LightDevice } from "./light/index.js";
import { LockDevice } from "./lock/index.js";
import { VideoPlayerDevice } from "./media-player/basic-video-player.js";
import {
  MediaPlayerDevice,
  SpeakerMediaPlayerDevice,
} from "./media-player/index.js";
import { PumpEndpoint } from "./pump/index.js";
import { RemoteDevice } from "./remote/index.js";
import { SceneDevice } from "./scene/index.js";
import { ScriptDevice } from "./script/index.js";
import { InputSelectDevice, SelectDevice } from "./select/index.js";
import { AirQualitySensorType } from "./sensor/devices/air-quality-sensor.js";
import { BatterySensorType } from "./sensor/devices/battery-sensor.js";
import { CarbonMonoxideSensorType } from "./sensor/devices/carbon-monoxide-sensor.js";
import { ElectricalSensorType } from "./sensor/devices/electrical-sensor.js";
import { FlowSensorType } from "./sensor/devices/flow-sensor.js";
import { FormaldehydeSensorType } from "./sensor/devices/formaldehyde-sensor.js";
import { HumiditySensorType } from "./sensor/devices/humidity-sensor.js";
import { IlluminanceSensorType } from "./sensor/devices/illuminance-sensor.js";
import { NitrogenDioxideSensorType } from "./sensor/devices/nitrogen-dioxide-sensor.js";
import { OzoneSensorType } from "./sensor/devices/ozone-sensor.js";
import { Pm1SensorType } from "./sensor/devices/pm1-sensor.js";
import { PressureSensorType } from "./sensor/devices/pressure-sensor.js";
import { RadonSensorType } from "./sensor/devices/radon-sensor.js";
import { TemperatureSensorType } from "./sensor/devices/temperature-sensor.js";
import { TvocSensorType } from "./sensor/devices/tvoc-sensor.js";
import { SensorDevice } from "./sensor/index.js";
import { SirenDevice } from "./siren/index.js";
import { DimmablePlugInUnitType } from "./switch/dimmable-plugin-unit.js";
import { SwitchDevice } from "./switch/index.js";
import { MountedOnOffControlType } from "./switch/mounted-on-off-control.js";
import { VacuumDevice } from "./vacuum/index.js";
import { ValveDevice } from "./valve/index.js";
import { WaterHeaterDevice } from "./water-heater/index.js";
import { WeatherDevice } from "./weather/index.js";

const legacyLogger = Logger.get("LegacyEndpointType");

/**
 * @deprecated
 */
export interface LegacyEndpointOptions {
  vacuumOnOff?: boolean;
  cleaningModeOptions?: string[];
  /** Domain mappings registered by plugins (domain → MatterDeviceType key) */
  pluginDomainMappings?: Map<string, string>;
}

export function createLegacyEndpointType(
  entity: HomeAssistantEntityInformation,
  mapping?: EntityMappingConfig,
  areaName?: string,
  options?: LegacyEndpointOptions,
): EndpointType | undefined {
  const domain = entity.entity_id.split(".")[0] as HomeAssistantDomain;
  const customName = mapping?.customName;

  let type: EndpointType | undefined;

  if (mapping?.matterDeviceType) {
    const overrideFactory = matterDeviceTypeFactories[mapping.matterDeviceType];
    if (overrideFactory) {
      type = overrideFactory({ entity, customName, mapping });
    }
  }

  if (!type) {
    // Vacuum needs special handling for the vacuumOnOff feature flag
    if (domain === "vacuum") {
      type = VacuumDevice(
        { entity, customName, mapping },
        options?.vacuumOnOff,
        options?.cleaningModeOptions,
      );
    } else {
      const factory = deviceCtrs[domain];
      if (factory) {
        type = factory({ entity, customName, mapping });
      } else if (options?.pluginDomainMappings?.has(domain)) {
        const mappedType = options.pluginDomainMappings.get(domain)!;
        const mappedFactory =
          matterDeviceTypeFactories[mappedType as MatterDeviceType];
        if (mappedFactory) {
          legacyLogger.info(
            `Using plugin domain mapping for "${domain}" → "${mappedType}"`,
          );
          type = mappedFactory({ entity, customName, mapping });
        }
      } else {
        return undefined;
      }
    }
  }

  if (!type) {
    return undefined;
  }

  validateEndpointType(type, entity.entity_id);

  if (areaName) {
    type = addFixedLabel(type, areaName);
  }

  return type;
}

/**
 * Add FixedLabel cluster with room name to an endpoint type.
 * Sets { label: "room", value: "<name>" } per Matter spec. No major controller
 * (Google Home, Apple Home, Alexa) currently reads this for automatic room
 * assignment, rooms must be assigned manually. The label is kept for future
 * controller support.
 *
 * Uses MutableEndpoint.with() to properly extend behaviors instead of manual
 * object spreading, which can lose MutableEndpoint metadata and cause
 * "Behaviors have errors" during endpoint initialization.
 */
function addFixedLabel(type: EndpointType, areaName: string): EndpointType {
  // Matter spec: LabelStruct label and value fields are max 16 bytes each.
  // Truncate area name to prevent validation failures.
  const truncatedName =
    areaName.length > 16 ? areaName.substring(0, 16) : areaName;
  const fixedLabel = FixedLabelServer.set({
    labelList: [{ label: "room", value: truncatedName }],
  });
  // All factory functions return MutableEndpoint which has .with()
  const mutable = type as EndpointType & {
    with(...behaviors: unknown[]): EndpointType;
  };
  if (typeof mutable.with === "function") {
    return mutable.with(fixedLabel);
  }
  // Fallback for non-mutable types (shouldn't happen in practice)
  return {
    ...type,
    behaviors: { ...type.behaviors, fixedLabel },
  } as EndpointType;
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
  select: SelectDevice,
  input_select: InputSelectDevice,
  scene: SceneDevice,
  siren: SirenDevice,
  media_player: MediaPlayerDevice,
  humidifier: HumidifierDevice,
  lawn_mower: LawnMowerDevice,
  vacuum: VacuumDevice,
  valve: ValveDevice,
  alarm_control_panel: AlarmControlPanelDevice,
  remote: RemoteDevice,
  water_heater: WaterHeaterDevice,
  event: EventDevice,
  weather: WeatherDevice,
};

const matterDeviceTypeFactories: Partial<
  Record<
    MatterDeviceType,
    (
      homeAssistant: HomeAssistantEntityBehavior.State,
    ) => EndpointType | undefined
  >
> = {
  on_off_light: (ha) => OnOffLightType.set({ homeAssistantEntity: ha }),
  dimmable_light: (ha) => DimmableLightType.set({ homeAssistantEntity: ha }),
  color_temperature_light: (ha) =>
    ColorTemperatureLightType.set({ homeAssistantEntity: ha }),
  extended_color_light: (ha) =>
    ExtendedColorLightType(true, true).set({ homeAssistantEntity: ha }),
  on_off_plugin_unit: (ha) => {
    const domain = ha.entity.entity_id.split(".")[0];
    if (domain === "alarm_control_panel") {
      return AlarmOnOffDevice(ha);
    }
    return SwitchDevice(ha);
  },
  dishwasher: DishwasherEndpoint,
  dimmable_plugin_unit: (ha) =>
    DimmablePlugInUnitType.set({ homeAssistantEntity: ha }),
  // Expose as On/Off Light (0x0100, an OnOff server) so controllers show a
  // switch instead of a plug. Plain SwitchDevice is 0x010A (a plug), so the
  // override had no effect before (#380).
  on_off_switch: (ha) => OnOffLightType.set({ homeAssistantEntity: ha }),
  // #380: expose an HA switch as Mounted On/Off Control (0x010F).
  mounted_on_off_control: (ha) =>
    MountedOnOffControlType.set({ homeAssistantEntity: ha }),
  door_lock: LockDevice,
  window_covering: CoverDevice,
  thermostat: ClimateDevice,
  fan: FanDevice,
  air_purifier: AirPurifierEndpoint,
  robot_vacuum_cleaner: (ha) => VacuumDevice(ha),
  robotic_lawn_mower: (ha) => LawnMowerDevice(ha),
  humidifier_dehumidifier: HumidifierDevice,
  speaker: SpeakerMediaPlayerDevice,
  basic_video_player: VideoPlayerDevice,
  humidity_sensor: (ha) => HumiditySensorType.set({ homeAssistantEntity: ha }),
  temperature_sensor: (ha) =>
    TemperatureSensorType.set({ homeAssistantEntity: ha }),
  pressure_sensor: (ha) => PressureSensorType.set({ homeAssistantEntity: ha }),
  light_sensor: (ha) => IlluminanceSensorType.set({ homeAssistantEntity: ha }),
  flow_sensor: (ha) => FlowSensorType.set({ homeAssistantEntity: ha }),
  air_quality_sensor: (ha) =>
    AirQualitySensorType.set({ homeAssistantEntity: ha }),
  battery_storage: (ha) => BatterySensorType.set({ homeAssistantEntity: ha }),
  tvoc_sensor: (ha) => TvocSensorType.set({ homeAssistantEntity: ha }),
  carbon_monoxide_sensor: (ha) =>
    CarbonMonoxideSensorType.set({ homeAssistantEntity: ha }),
  nitrogen_dioxide_sensor: (ha) =>
    NitrogenDioxideSensorType.set({ homeAssistantEntity: ha }),
  ozone_sensor: (ha) => OzoneSensorType.set({ homeAssistantEntity: ha }),
  formaldehyde_sensor: (ha) =>
    FormaldehydeSensorType.set({ homeAssistantEntity: ha }),
  radon_sensor: (ha) => RadonSensorType.set({ homeAssistantEntity: ha }),
  pm1_sensor: (ha) => Pm1SensorType.set({ homeAssistantEntity: ha }),
  electrical_sensor: (ha) =>
    ElectricalSensorType.set({ homeAssistantEntity: ha }),
  contact_sensor: (ha) => ContactSensorType.set({ homeAssistantEntity: ha }),
  motion_sensor: (ha) => MotionSensorType.set({ homeAssistantEntity: ha }),
  occupancy_sensor: (ha) =>
    OccupancySensorType.set({ homeAssistantEntity: ha }),
  mode_select: SelectDevice,
  water_valve: ValveDevice,
  pump: PumpEndpoint,
  rain_sensor: (ha) => RainSensorType.set({ homeAssistantEntity: ha }),
  water_heater: WaterHeaterDevice,
  generic_switch: EventDevice,
  smoke_co_alarm: (ha) => SmokeAlarmType.set({ homeAssistantEntity: ha }),
  water_freeze_detector: (ha) =>
    WaterFreezeDetectorType.set({ homeAssistantEntity: ha }),
  water_leak_detector: (ha) =>
    WaterLeakDetectorType.set({ homeAssistantEntity: ha }),
};
