import {
  type LightDeviceAttributes,
  LightDeviceColorMode,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { HaElectricalEnergyMeasurementServer } from "../../../behaviors/electrical-energy-measurement-server.js";
import { HaElectricalPowerMeasurementServer } from "../../../behaviors/electrical-power-measurement-server.js";
import type { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { HaPowerTopologyServer } from "../../../behaviors/power-topology-server.js";
import {
  DimmableLightType,
  DimmableLightWithBatteryType,
} from "./devices/dimmable-light.js";
import { ExtendedColorLightType } from "./devices/extended-color-light.js";
import {
  OnOffLightType,
  OnOffLightWithBatteryType,
} from "./devices/on-off-light-device.js";

const brightnessModes: LightDeviceColorMode[] = Object.values(
  LightDeviceColorMode,
)
  .filter((mode) => mode !== LightDeviceColorMode.UNKNOWN)
  .filter((mode) => mode !== LightDeviceColorMode.ONOFF);

const colorModes: LightDeviceColorMode[] = [
  LightDeviceColorMode.HS,
  LightDeviceColorMode.RGB,
  LightDeviceColorMode.XY,
  LightDeviceColorMode.RGBW,
  LightDeviceColorMode.RGBWW,
];

// on/off 0, dimmable 1, color or color temperature 2. Picks the device type
// below and is the light element of the mapping fingerprint, so a light built
// from a reduced snapshot (unavailable at start) rebuilds once it upgrades.
export function lightShape(modes: readonly LightDeviceColorMode[]) {
  const supportsColorControl = modes.some((mode) => colorModes.includes(mode));
  const supportsColorTemperature = modes.includes(
    LightDeviceColorMode.COLOR_TEMP,
  );
  const supportsBrightness = modes.some((mode) =>
    brightnessModes.includes(mode),
  );
  const rank =
    supportsColorControl || supportsColorTemperature
      ? 2
      : supportsBrightness
        ? 1
        : 0;
  return { supportsColorControl, supportsColorTemperature, rank };
}

export function LightDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as LightDeviceAttributes & {
    battery?: number;
    battery_level?: number;
  };

  const { supportsColorControl, supportsColorTemperature, rank } = lightShape(
    attributes.supported_color_modes ?? [],
  );
  const hasBatteryAttr =
    attributes.battery_level != null || attributes.battery != null;
  const hasBatteryEntity = !!homeAssistantEntity.mapping?.batteryEntity;
  const hasBattery = hasBatteryAttr || hasBatteryEntity;

  // Use ExtendedColorLight for all color-capable lights, including ColorTemperature-only lights.
  // ColorTemperatureLightDevice has issues with Matter.js initialization that cause
  // "Behaviors have errors" during endpoint creation. ExtendedColorLight works correctly
  // with just the ColorTemperature feature enabled (supportsColorControl=false).
  const deviceType =
    rank === 2
      ? ExtendedColorLightType(
          supportsColorControl,
          supportsColorTemperature,
          hasBattery,
        )
      : rank === 1
        ? hasBattery
          ? DimmableLightWithBatteryType
          : DimmableLightType
        : hasBattery
          ? OnOffLightWithBatteryType
          : OnOffLightType;
  const hasPowerEntity = !!homeAssistantEntity.mapping?.powerEntity;
  const hasEnergyEntity = !!homeAssistantEntity.mapping?.energyEntity;
  // Voltage/current can be mapped on their own, so gate the power cluster on
  // any of the three or that data would be dropped.
  const hasElectricalPower =
    hasPowerEntity ||
    !!homeAssistantEntity.mapping?.voltageEntity ||
    !!homeAssistantEntity.mapping?.currentEntity;

  // biome-ignore lint/suspicious/noExplicitAny: Union type doesn't support .with() directly
  let device: any = deviceType;
  if (hasElectricalPower || hasEnergyEntity) {
    device = device.with(HaPowerTopologyServer);
  }
  if (hasElectricalPower) {
    device = device.with(HaElectricalPowerMeasurementServer);
  }
  if (hasEnergyEntity) {
    device = device.with(HaElectricalEnergyMeasurementServer);
  }

  return device.set({ homeAssistantEntity });
}
