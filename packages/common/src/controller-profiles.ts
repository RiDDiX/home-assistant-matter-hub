import type { BridgeFeatureFlags, BridgeIconType } from "./bridge-data.js";

export type ControllerType =
  | "apple_home"
  | "google_home"
  | "alexa"
  | "multi_controller";

export interface ControllerProfile {
  readonly id: ControllerType;
  readonly name: string;
  readonly description: string;
  readonly icon: BridgeIconType;
  readonly featureFlags: BridgeFeatureFlags;
}

export const controllerProfiles: ControllerProfile[] = [
  {
    id: "apple_home",
    name: "Apple Home",
    description:
      "Optimized for Apple Home and Siri. Enables composed devices for clean sensor grouping. " +
      "Covers use standard Matter percentage (inverted from HA).",
    icon: "default",
    featureFlags: {
      autoComposedDevices: true,
      autoBatteryMapping: true,
      autoHumidityMapping: true,
      autoPressureMapping: true,
    },
  },
  {
    id: "google_home",
    name: "Google Home",
    description:
      "Optimized for Google Home. Enables Auto Force Sync to prevent devices from going offline. " +
      "Composed devices enabled for proper sensor grouping.",
    icon: "default",
    featureFlags: {
      autoForceSync: true,
      autoComposedDevices: true,
      autoBatteryMapping: true,
      autoHumidityMapping: true,
      autoPressureMapping: true,
    },
  },
  {
    id: "alexa",
    name: "Amazon Alexa",
    description:
      "Optimized for Alexa. Enables Auto Force Sync and Alexa-friendly cover percentages. " +
      "Battery mapping included for sensor devices.",
    icon: "default",
    featureFlags: {
      autoForceSync: true,
      autoBatteryMapping: true,
      autoHumidityMapping: true,
      autoPressureMapping: true,
      coverUseHomeAssistantPercentage: true,
    },
  },
  {
    id: "multi_controller",
    name: "Multi-Controller",
    description:
      "Balanced settings for use with multiple controllers at once (e.g. Apple Home + Alexa). " +
      "Force Sync enabled. Standard cover behavior.",
    icon: "default",
    featureFlags: {
      autoForceSync: true,
      autoComposedDevices: true,
      autoBatteryMapping: true,
      autoHumidityMapping: true,
      autoPressureMapping: true,
    },
  },
];
