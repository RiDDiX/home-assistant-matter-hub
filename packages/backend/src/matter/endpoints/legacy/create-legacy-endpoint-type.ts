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
import { GarageDoorDevice } from "./garage-door/index.js";
import { HumidifierDevice } from "./humidifier/index.js";
import { InputButtonDevice } from "./input-button/index.js";
import { ColorTemperatureLightType } from "./light/devices/color-temperature-light.js";
import { DimmableLightType } from "./light/devices/dimmable-light.js";
import { ExtendedColorLightType } from "./light/devices/extended-color-light.js";
import { OnOffLightType } from "./light/devices/on-off-light-device.js";
import { LightDevice } from "./light/index.js";
import { LockDevice } from "./lock/index.js";
import { MediaPlayerDevice } from "./media-player/index.js";
import { SceneDevice } from "./scene/index.js";
import { ScriptDevice } from "./script/index.js";
import { SensorDevice } from "./sensor/index.js";
import { SwitchDevice } from "./switch/index.js";
import { VacuumDevice } from "./vacuum/index.js";
import { ValveDevice } from "./valve/index.js";

/**
 * @deprecated
 */
export function createLegacyEndpointType(
  entity: HomeAssistantEntityInformation,
  mapping?: EntityMappingConfig,
): EndpointType | undefined {
  const domain = entity.entity_id.split(".")[0] as HomeAssistantDomain;

  if (mapping?.matterDeviceType) {
    const overrideFactory = matterDeviceTypeFactories[mapping.matterDeviceType];
    if (overrideFactory) {
      return overrideFactory({ entity });
    }
  }

  const factory = deviceCtrs[domain];
  if (!factory) {
    return undefined;
  }
  return factory({ entity });
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
    ExtendedColorLightType(true).set({ homeAssistantEntity: ha }),
  on_off_plugin_unit: SwitchDevice,
  on_off_switch: SwitchDevice,
  door_lock: LockDevice,
  garage_door: GarageDoorDevice,
  window_covering: CoverDevice,
  thermostat: ClimateDevice,
  fan: FanDevice,
  air_purifier: AirPurifierEndpoint,
  robot_vacuum_cleaner: VacuumDevice,
  humidifier_dehumidifier: HumidifierDevice,
};
