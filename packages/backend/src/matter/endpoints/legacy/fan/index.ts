import {
  type FanDeviceAttributes,
  FanDeviceFeature,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import type { FanControl } from "@matter/main/clusters";
import {
  FanDevice as Device,
  OnOffPlugInUnitDevice,
} from "@matter/main/devices";
import { autoPresetName } from "../../../../utils/converters/fan-mode.js";
import type { FeatureSelection } from "../../../../utils/feature-selection.js";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { FanSpeedMemoryBehavior } from "../../../behaviors/fan-speed-memory.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { DefaultPowerSourceServer } from "../../../behaviors/power-source-server.js";
import { FanFanControlServer } from "./behaviors/fan-fan-control-server.js";
import { FanOnOffServer } from "./behaviors/fan-on-off-server.js";

export function FanDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as FanDeviceAttributes & {
    battery?: number;
    battery_level?: number;
  };
  const supportedFeatures = attributes.supported_features ?? 0;
  const hasBatteryAttr =
    attributes.battery_level != null || attributes.battery != null;
  const hasBatteryEntity = !!homeAssistantEntity.mapping?.batteryEntity;
  const hasBattery = hasBatteryAttr || hasBatteryEntity;

  const hasSetSpeed = testBit(supportedFeatures, FanDeviceFeature.SET_SPEED);
  const hasPresetMode = testBit(
    supportedFeatures,
    FanDeviceFeature.PRESET_MODE,
  );
  const presetModes = attributes.preset_modes ?? [];
  // Filter out "Auto" from presets for speed calculation
  const speedPresets = presetModes.filter((m) => m.toLowerCase() !== "auto");

  // On/off-only fan: no speed control and no speed-capable preset modes.
  // Use OnOffPlugInUnitDevice to avoid controllers showing percentage/speed
  // controls from the FanControl cluster's mandatory percentSetting attribute.
  if (!hasSetSpeed && speedPresets.length === 0) {
    const onOffDevice = hasBattery
      ? OnOffPlugInUnitDevice.with(
          IdentifyServer,
          BasicInformationServer,
          HomeAssistantEntityBehavior,
          GroupsServer,
          ScenesManagementServer,
          FanOnOffServer,
          DefaultPowerSourceServer,
        )
      : OnOffPlugInUnitDevice.with(
          IdentifyServer,
          BasicInformationServer,
          HomeAssistantEntityBehavior,
          GroupsServer,
          ScenesManagementServer,
          FanOnOffServer,
        );
    return onOffDevice.set({ homeAssistantEntity });
  }

  const features: FeatureSelection<typeof FanControl.Cluster> = new Set();

  // Enable MultiSpeed and Step for fans with percentage control OR preset modes
  // For preset-only fans, speeds are mapped to preset modes (Low/Medium/High etc.)
  if (hasSetSpeed || speedPresets.length > 0) {
    features.add("MultiSpeed");
    features.add("Step");
  }

  // Auto only if a preset really is "auto", else HA rejects the "Auto" we send (#387).
  if (hasPresetMode && autoPresetName(presetModes) !== undefined) {
    features.add("Auto");
  }
  if (testBit(supportedFeatures, FanDeviceFeature.DIRECTION)) {
    features.add("AirflowDirection");
  }
  // Enable Rocking (oscillation) if fan supports it
  if (testBit(supportedFeatures, FanDeviceFeature.OSCILLATE)) {
    features.add("Rocking");
  }
  // Enable Wind mode if fan has english natural/sleep presets, or localized
  // ones the user mapped via fanWindPresets (#387).
  const windPresets = homeAssistantEntity.mapping?.fanWindPresets;
  const hasWindModes = presetModes.some(
    (m) =>
      m.toLowerCase() === "natural" ||
      m.toLowerCase() === "nature" ||
      m.toLowerCase() === "sleep" ||
      !!windPresets?.natural?.includes(m) ||
      !!windPresets?.sleep?.includes(m),
  );
  if (hasWindModes) {
    features.add("Wind");
  }

  const device = hasBattery
    ? Device.with(
        IdentifyServer,
        BasicInformationServer,
        HomeAssistantEntityBehavior,
        GroupsServer,
        FanOnOffServer,
        FanFanControlServer.with(...features),
        FanSpeedMemoryBehavior,
        DefaultPowerSourceServer,
      )
    : Device.with(
        IdentifyServer,
        BasicInformationServer,
        HomeAssistantEntityBehavior,
        GroupsServer,
        FanOnOffServer,
        FanFanControlServer.with(...features),
        FanSpeedMemoryBehavior,
      );
  return device.set({ homeAssistantEntity });
}
