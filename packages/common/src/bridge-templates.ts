import type { BridgeFeatureFlags, BridgeIconType } from "./bridge-data.js";
import type { HomeAssistantFilter } from "./home-assistant-filter.js";
import { HomeAssistantMatcherType } from "./home-assistant-filter.js";

export interface BridgeTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: BridgeIconType;
  readonly filter: HomeAssistantFilter;
  readonly featureFlags?: BridgeFeatureFlags;
  readonly tags: string[];
}

export const bridgeTemplates: BridgeTemplate[] = [
  {
    id: "all_lights",
    name: "All Lights",
    description:
      "Expose all light entities. Ideal for controlling lights via Apple Home, Google Home, or Alexa.",
    icon: "💡",
    filter: {
      include: [{ type: HomeAssistantMatcherType.Domain, value: "light" }],
      exclude: [],
    },
    featureFlags: {
      autoBatteryMapping: true,
    },
    tags: ["lights", "popular"],
  },
  {
    id: "all_switches",
    name: "All Switches & Plugs",
    description:
      "Expose all switch entities including smart plugs. Includes power and energy monitoring.",
    icon: "🔌",
    filter: {
      include: [{ type: HomeAssistantMatcherType.Domain, value: "switch" }],
      exclude: [],
    },
    featureFlags: {},
    tags: ["switches", "plugs"],
  },
  {
    id: "sensors_only",
    name: "All Sensors",
    description:
      "Expose temperature, humidity, pressure, and other sensors. Auto-combines related sensors from the same device.",
    icon: "📊",
    filter: {
      include: [
        { type: HomeAssistantMatcherType.Domain, value: "sensor" },
        { type: HomeAssistantMatcherType.Domain, value: "binary_sensor" },
      ],
      exclude: [],
    },
    featureFlags: {
      autoBatteryMapping: true,
      autoHumidityMapping: true,
      autoPressureMapping: true,
    },
    tags: ["sensors", "temperature", "humidity"],
  },
  {
    id: "climate_control",
    name: "Climate & Covers",
    description:
      "Expose thermostats, fans, covers, and humidifiers for climate control.",
    icon: "🌡️",
    filter: {
      include: [
        { type: HomeAssistantMatcherType.Domain, value: "climate" },
        { type: HomeAssistantMatcherType.Domain, value: "fan" },
        { type: HomeAssistantMatcherType.Domain, value: "cover" },
        { type: HomeAssistantMatcherType.Domain, value: "humidifier" },
      ],
      exclude: [],
    },
    featureFlags: {
      autoBatteryMapping: true,
    },
    tags: ["climate", "thermostat", "covers"],
  },
  {
    id: "security",
    name: "Security & Locks",
    description:
      "Expose locks, alarm panels, and security-related binary sensors (motion, door, window).",
    icon: "🔒",
    filter: {
      include: [
        { type: HomeAssistantMatcherType.Domain, value: "lock" },
        { type: HomeAssistantMatcherType.Domain, value: "alarm_control_panel" },
        {
          type: HomeAssistantMatcherType.DeviceClass,
          value: "motion",
        },
        {
          type: HomeAssistantMatcherType.DeviceClass,
          value: "door",
        },
        {
          type: HomeAssistantMatcherType.DeviceClass,
          value: "window",
        },
      ],
      exclude: [],
      includeMode: "any",
    },
    featureFlags: {
      autoBatteryMapping: true,
    },
    tags: ["security", "locks", "alarm"],
  },
  {
    id: "robot_vacuum",
    name: "Robot Vacuum (Server Mode)",
    description:
      "Single vacuum bridge with Server Mode enabled. Required for Apple Home Siri commands and proper Alexa discovery. Add only ONE vacuum to this bridge.",
    icon: "🤖",
    filter: {
      include: [{ type: HomeAssistantMatcherType.Domain, value: "vacuum" }],
      exclude: [],
    },
    featureFlags: {
      serverMode: true,
    },
    tags: ["vacuum", "server-mode", "apple-home"],
  },
  {
    id: "media_players",
    name: "Media Players & Speakers",
    description:
      "Expose media players, speakers, and TVs for volume and playback control.",
    icon: "🎵",
    filter: {
      include: [
        { type: HomeAssistantMatcherType.Domain, value: "media_player" },
      ],
      exclude: [],
    },
    featureFlags: {},
    tags: ["media", "speakers", "tv"],
  },
  {
    id: "google_home_optimized",
    name: "Google Home Optimized",
    description:
      "All devices with Auto Force Sync enabled. Prevents Google Home from showing devices as offline after a few hours.",
    icon: "✨",
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: "*" }],
      exclude: [],
    },
    featureFlags: {
      autoForceSync: true,
      autoBatteryMapping: true,
      autoHumidityMapping: true,
      autoPressureMapping: true,
    },
    tags: ["google-home", "all-devices"],
  },
  {
    id: "alexa_covers",
    name: "Alexa-Optimized Covers",
    description:
      "Covers with Alexa-friendly percentage display. Displayed percentage matches Home Assistant values.",
    icon: "🪟",
    filter: {
      include: [{ type: HomeAssistantMatcherType.Domain, value: "cover" }],
      exclude: [],
    },
    featureFlags: {
      coverUseHomeAssistantPercentage: true,
      autoBatteryMapping: true,
    },
    tags: ["alexa", "covers"],
  },
  {
    id: "automations_scripts",
    name: "Automations & Scripts",
    description:
      "Expose Home Assistant automations, scripts, and scenes as Matter switches.",
    icon: "🎛️",
    filter: {
      include: [
        { type: HomeAssistantMatcherType.Domain, value: "automation" },
        { type: HomeAssistantMatcherType.Domain, value: "script" },
        { type: HomeAssistantMatcherType.Domain, value: "scene" },
      ],
      exclude: [],
    },
    featureFlags: {},
    tags: ["automations", "scripts", "scenes"],
  },
];
