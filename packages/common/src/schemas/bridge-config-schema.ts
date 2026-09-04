import type { JSONSchema7 } from "json-schema";

const homeAssistantMatcherSchema: JSONSchema7 = {
  type: "object",
  default: { type: "", value: "" },
  properties: {
    type: {
      title: "Type",
      type: "string",
      oneOf: [
        {
          const: "pattern",
          title: "pattern",
          description:
            "Wildcard pattern matching entity IDs. Use * as wildcard. Example: 'light.living_room_*' matches all lights in the living room.",
        },
        {
          const: "regex",
          title: "regex",
          description:
            "Regex tested against the entity_id only (e.g. 'light.kitchen_lamp'). For labels use entity_label_regex or device_label_regex. Example: '^(light|switch)\\.kitchen_.*'.",
        },
        {
          const: "domain",
          title: "domain",
          description:
            "Match entities by their domain (the part before the dot). Example: 'light', 'switch', 'sensor'.",
        },
        {
          const: "platform",
          title: "platform",
          description:
            "Match entities by their integration/platform. Example: 'hue', 'zwave', 'mqtt'.",
        },
        {
          const: "label",
          title: "label (deprecated)",
          description:
            "Deprecated: use entity_label or device_label instead. Behaves like entity_label.",
        },
        {
          const: "entity_label",
          title: "entity_label",
          description:
            "Matches only entities that have this label assigned directly. Other entities of the same device are NOT included.",
        },
        {
          const: "device_label",
          title: "device_label",
          description:
            "Matches ALL entities of a device if the device has this label. Use this to include a complete device with all its entities.",
        },
        {
          const: "entity_label_regex",
          title: "entity_label_regex",
          description:
            "Regex tested against entity-label slugs and display names. Matches if any label assigned to the entity matches. Example: '^(matter|voice).*'.",
        },
        {
          const: "device_label_regex",
          title: "device_label_regex",
          description:
            "Regex tested against device-label slugs and display names. Matches ALL entities of a device whose label matches. Example: '^(matter|voice).*'.",
        },
        {
          const: "any_field_regex",
          title: "any_field_regex",
          description:
            "Regex tested against a single-line key=value haystack covering entity_id, domain, platform, area, entity_category, device_class, entity_labels, entity_label_names, device_labels, device_label_names, device_name, product_name, manufacturer. Use lookaheads for AND, alternation for OR. Example: '(?=.*domain=light)(?=.*area=living_room)|(?=.*domain=switch)(?=.*entity_labels=.*\\bvoice\\b)'.",
        },
        {
          const: "area",
          title: "area",
          description:
            "Match entities by their area slug. Example: 'living_room', 'bedroom'.",
        },
        {
          const: "entity_category",
          title: "entity_category",
          description:
            "Match entities by their category. Example: 'config', 'diagnostic' to exclude configuration entities.",
        },
        {
          const: "device_name",
          title: "device_name",
          description:
            "Match entities by their device name. Supports wildcards. Example: '*Philips*' matches all Philips devices.",
        },
        {
          const: "product_name",
          title: "product_name",
          description:
            "Match entities by their product/model name. Supports wildcards. Example: 'Hue*Bulb'.",
        },
        {
          const: "manufacturer",
          title: "manufacturer",
          description:
            "Match entities by their device manufacturer. Supports wildcards. Handy for MQTT or other generic integrations. Example: '*Sonoff*'.",
        },
        {
          const: "device_class",
          title: "device_class",
          description:
            "Match entities by their device class attribute. Example: 'temperature', 'motion', 'door', 'window'.",
        },
      ],
    },
    value: {
      title: "Value",
      description:
        "For labels, use the display name or the label_id (slug). You can look up both on the Labels page in the sidebar.",
      type: "string",
      minLength: 1,
    },
  },
  required: ["type", "value"],
  additionalProperties: false,
};

const homeAssistantFilterSchema: JSONSchema7 = {
  title: "Include or exclude entities",
  type: "object",
  properties: {
    include: {
      title: "Include",
      type: "array",
      items: homeAssistantMatcherSchema,
    },
    exclude: {
      title: "Exclude",
      type: "array",
      items: homeAssistantMatcherSchema,
    },
    includeMode: {
      title: "Include Mode",
      type: "string",
      description:
        "How to combine include rules: 'any' matches if ANY rule matches (OR), 'all' matches only if ALL rules match (AND). Default: 'any'",
      enum: ["any", "all"],
      default: "any",
    },
  },
  required: ["include", "exclude"],
  additionalProperties: false,
};

const featureFlagSchema: JSONSchema7 = {
  title: "Feature Flags",
  type: "object",
  properties: {
    coverDoNotInvertPercentage: {
      title: "Do not invert Percentages for Covers",
      description:
        "Do not invert the percentage of covers to match Home Assistant (not Matter compliant)",
      type: "boolean",
      default: false,
    },

    coverUseHomeAssistantPercentage: {
      title: "Use Home Assistant Percentage for Covers (Alexa-friendly)",
      description:
        "Display cover percentages matching Home Assistant values in Matter controllers like Alexa. " +
        "This makes the displayed percentage match what you see in Home Assistant, but the semantic meaning differs: " +
        "in HA, higher percentage = more open; in Alexa, higher percentage is typically interpreted as more closed. " +
        "Open/Close commands will still work correctly.",
      type: "boolean",
      default: false,
    },

    coverSwapOpenClose: {
      title: "Swap Open/Close for Covers",
      description:
        "Swap open/close commands and invert position reporting for covers. Enable this if Alexa voice commands " +
        "are reversed (saying 'close' opens the blinds and vice versa).",
      type: "boolean",
      default: false,
    },

    includeHiddenEntities: {
      title: "Include Hidden Entities",
      description:
        "Include entities that are marked as hidden in Home Assistant",
      type: "boolean",
      default: false,
    },

    serverMode: {
      title: "Server Mode (standalone device)",
      description:
        "Expose entities as standalone Matter devices instead of bridged ones. " +
        "Works for any supported device type, e.g. robot vacuums need it for Apple Home Siri voice commands. " +
        "One node carries up to 10 devices; the first entity is the primary and drives the node name and type (experimental beyond one device).",
      type: "boolean",
      default: false,
    },

    autoBatteryMapping: {
      title: "Auto Battery Mapping",
      description:
        "Automatically assign battery sensors from the same Home Assistant device to the main entity. " +
        "When enabled, battery sensors will be merged into their parent devices instead of appearing as separate devices.",
      type: "boolean",
      default: false,
    },

    autoHumidityMapping: {
      title: "Auto Humidity Mapping",
      description:
        "Automatically combine humidity sensors with temperature sensors from the same Home Assistant device. " +
        "When enabled, humidity sensors will be merged into temperature sensors to create combined TemperatureHumiditySensor devices.",
      type: "boolean",
      default: true,
    },

    autoPressureMapping: {
      title: "Auto Pressure Mapping",
      description:
        "Automatically combine pressure sensors with temperature sensors from the same Home Assistant device. " +
        "When enabled, pressure sensors will be merged into temperature sensors to create combined sensor devices.",
      type: "boolean",
      default: true,
    },

    autoComposedDevices: {
      title: "Auto Composed Devices",
      description:
        "A temperature sensor with its humidity and pressure sensors becomes one device with a sub-device per reading, " +
        "battery on the parent. Off, they share one endpoint and Apple Home shows no humidity. Also forces battery, " +
        "humidity and pressure auto-mapping on and unlocks Composed Sub-Entities and air purifier grouping. " +
        "Controllers see new devices; existing ones change shape after a bridge restart.",
      type: "boolean",
      default: false,
    },

    autoForceSync: {
      title: "Auto Force Sync",
      description:
        "Periodically compare and push all device states to connected controllers every 90 seconds. " +
        "Enable this if devices get out of sync after extended periods. " +
        "Health checks for dead sessions always run regardless of this setting.",
      type: "boolean",
      default: false,
    },

    productNameFromNodeLabel: {
      title: "Product Name from Node Label",
      description:
        "Report the entity's node label (custom name / friendly name / entity id) as the Matter productName. " +
        "Useful for controllers like Aqara that display productName as the device name instead of nodeLabel. " +
        "A per-entity customProductName still takes precedence.",
      type: "boolean",
      default: false,
    },

    preferEntityRegistryName: {
      title: "Prefer Entity Registry Name (HA 2026.4 workaround)",
      description:
        "Use the entity registry name (or original_name) as nodeLabel instead of the composed friendly_name. " +
        "Since Home Assistant 2026.4, friendly_name is prefixed with the device name, which breaks voice " +
        "commands that relied on the short entity name. " +
        "Resolution order: customName → registry name → registry original_name → friendly_name → entity_id. " +
        "Matter has no alias concept, this only changes which single name is reported.",
      type: "boolean",
      default: false,
    },

    vacuumOnOff: {
      title: "Vacuum: Include OnOff Cluster (Alexa)",
      description:
        "Add an OnOff cluster to robot vacuum endpoints. " +
        "Alexa REQUIRES this (PowerController) to show robotic vacuums in the app. " +
        "Without it, Alexa commissions the device but never displays it. " +
        "In Server Mode this is enabled automatically, only check this for bridge mode. " +
        "WARNING: OnOff is NOT part of the Matter RVC device type specification. " +
        "Enabling this may break Apple Home (shows 'Updating') and Google Home.",
      type: "boolean",
    },

    alexaPreserveBrightnessOnTurnOn: {
      title: "Alexa: Preserve Brightness on Turn-On",
      description:
        "Workaround for Alexa resetting light brightness to 100% after subscription renewal. " +
        "When enabled, the bridge ignores brightness commands that set lights to 100% within " +
        "200ms of a turn-on command for the same light. " +
        "WARNING: breaks Apple Home's 'set room to 100%' Siri commands, which use the same " +
        "on() + moveToLevel(254) pattern. Only enable on Alexa-only bridges.",
      type: "boolean",
      default: false,
    },

    useHaRegistrySerial: {
      title: "Use HA Registry Serial Number",
      description:
        "Fall back to the Home Assistant device registry serial_number when no per-entity " +
        "customSerialNumber is configured. Default off because changing serialNumber after " +
        "commissioning can confuse controllers. A per-entity customSerialNumber still " +
        "takes precedence.",
      type: "boolean",
      default: false,
    },

    coverSliderDebounceMs: {
      title: "Cover Slider Debounce (ms)",
      description:
        "Override the cover position-update debounce window for this bridge. " +
        "Some controllers (Apple Home) stream slider updates while the user is " +
        "still dragging, causing covers to start moving toward an intermediate " +
        "target. Set to the time the bridge should wait after the last update " +
        "before sending the final value to Home Assistant. 0 keeps the built-in " +
        "two-phase debounce (400 ms initial / 150 ms subsequent), which fits " +
        "most controllers. Try 800-1500 ms for slow blinds. " +
        "A per-entity override on a single cover wins over this flag.",
      type: "number",
      minimum: 0,
      maximum: 5000,
      default: 0,
    },

    fanSliderDebounceMs: {
      title: "Fan Slider Debounce (ms)",
      description:
        "Wait this long after the last inbound fan-speed write before sending it " +
        "to Home Assistant. Controllers stream percentSetting while the user is " +
        "still dragging - one Google Home drag was measured emitting nine writes " +
        "in eight seconds - and on IR or UART bridged air conditioners every write " +
        "is a device frame that makes the unit beep. 0 (the default) sends every " +
        "write immediately, matching previous behaviour. Try 1000-2000 ms for " +
        "bridged ACs. A per-entity override on a single fan or climate wins over " +
        "this flag.",
      type: "number",
      minimum: 0,
      maximum: 10000,
      default: 0,
    },

    advertiseSpecVersion151: {
      title: "Advertise Matter 1.5.1 (Alexa pairing diagnostic)",
      description:
        "Mask the Matter version identifiers as 1.5.1 instead of 1.6.0, in " +
        "the BasicInformation attributes and the session parameters. The " +
        "data model itself stays 1.6. Only for diagnosing Alexa pairing " +
        "failures that stop right after the " +
        "attestation step (#449): 2.0.49 was the last release to advertise " +
        "1.5.1 and the last with a confirmed Echo pairing. Every controller " +
        "on this bridge sees the masked version on its next reconnect, so " +
        "use a dedicated test bridge, and restart the bridge plus re-pair " +
        "the Echo after changing it. Default off.",
      type: "boolean",
      default: false,
    },

    supportTermsAndConditions: {
      title: "Accept Terms and Conditions commands (Alexa pairing diagnostic)",
      description:
        "Advertise the Matter 1.4 TermsAndConditions feature and accept the " +
        "SetTcAcknowledgements command instead of rejecting it as unsupported. " +
        "No terms are enforced, the bridge accepts any acknowledgement. Alexa " +
        "sends this command during pairing and some Echo firmwares may stall " +
        "when it fails (#449). Restart the bridge and re-pair after changing " +
        "it. Default off.",
      type: "boolean",
      default: false,
    },

    enableMatterTcp: {
      title: "Matter over TCP (Alexa pairing diagnostic)",
      description:
        "Open a Matter TCP listener and advertise TCP support alongside UDP. " +
        "Some controllers support Matter over TCP and may attempt it, the " +
        "Echo Dot advertises it (#449). Camera bridges enable this " +
        "automatically already. Restart the bridge and re-pair after " +
        "enabling it. Disabling needs a matterhub restart. Default off.",
      type: "boolean",
      default: false,
    },

    fastSessionRecovery: {
      title: "Fast Session Recovery (Google offline workaround)",
      description:
        "When a controller drops all subscriptions, clean up the dead session " +
        "and re-announce after 5 seconds instead of 60. Opt-in for Google Home " +
        "users whose devices go offline after a cancelled subscription (#386). " +
        "It shortens the offline window but cannot stop the controller from " +
        "rejecting the subscription. Default off.",
      type: "boolean",
      default: false,
    },

    omitEventsInPriming: {
      title: "Omit Events From Priming (Google offline workaround)",
      description:
        "Omit stored StartUp and BootReason events from priming reports. " +
        "Some Google controllers ack chunks but do not answer the final event " +
        "chunk, aborting the subscription and leaving the device offline " +
        "(#424). Live events still work. Off-spec; enable only for affected " +
        "Google fabrics. Applies to the next subscription. Default off.",
      type: "boolean",
      default: false,
    },

    stableIdentity: {
      title: "Stable Device Identity",
      description:
        "Anchor each device to its Home Assistant entity registry id instead " +
        "of the entity id, so renaming an entity no longer re-adds it in your " +
        "controller (Alexa, Google Home, Apple Home) and keeps groups and " +
        "automations. Records are seeded from the start, so enabling this later " +
        "is safe and never re-adds existing devices. Default off.",
      type: "boolean",
      default: false,
    },

    wedgeWatchdog: {
      title: "Wedge Watchdog (Apple 'Updating' workaround)",
      description:
        "Rotate the one session that looks wedged, subscriptions still alive " +
        "but no inbound request from the controller for about 45 minutes, " +
        "earlier than the blind session rotation. Targets Apple Home tiles " +
        "stuck on 'Updating' where the controller keeps acking but stops " +
        "consuming data. A false positive only triggers a transparent " +
        "reconnect, the same as normal rotation. Default off.",
      type: "boolean",
      default: false,
    },

    composedPrimaryOnParent: {
      title: "Composed Devices: Primary Entity On The Parent Endpoint",
      description:
        "For devices you group yourself with Composed Sub-Entities, needs " +
        "autoComposedDevices on as well. Puts the primary entity on the parent " +
        "endpoint instead of on an extra sub-endpoint, so the device advertises " +
        "its own type (light, switch, ...) the way an uncomposed device does. " +
        "Automatically composed sensors, air purifiers and climate/fan devices " +
        "are not affected. Apple " +
        "Home otherwise has no type to read on the parent and labels the whole " +
        "accessory after one of the grouped entities, for example an outlet " +
        "icon for a composed light. Takes effect after the bridge restarts, " +
        "and changes the endpoint layout, so composed devices have to be " +
        "removed and added again in your controller. Try it on one bridge " +
        "first: Apple Home has been seen to stop listing the grouped entities " +
        "once the parent carries its own device type. Default off.",
      type: "boolean",
      default: false,
    },
  },
};

export const bridgeConfigSchema: JSONSchema7 = {
  type: "object",
  title: "Bridge Config",
  properties: {
    name: {
      title: "Name",
      type: "string",
      minLength: 1,
      maxLength: 32,
    },
    port: {
      title: "Port",
      type: "number",
      minimum: 1,
    },
    icon: {
      title: "Icon",
      type: "string",
      description: "Icon to display for this bridge in the UI",
      enum: [
        "light",
        "switch",
        "climate",
        "cover",
        "fan",
        "lock",
        "sensor",
        "media_player",
        "vacuum",
        "remote",
        "humidifier",
        "speaker",
        "garage",
        "door",
        "window",
        "motion",
        "battery",
        "power",
        "camera",
        "default",
      ],
    },
    countryCode: {
      title: "Country Code",
      type: "string",
      description:
        "An ISO 3166-1 alpha-2 code to represent the country in which the Node is located. Only needed if the commissioning fails due to missing country code.",
      minLength: 2,
      maxLength: 3,
    },
    priority: {
      title: "Startup Priority",
      type: "number",
      description:
        "Startup order priority. Lower values start first. Default is 100.",
      default: 100,
      minimum: 1,
      maximum: 999,
    },
    serialNumberSuffix: {
      title: "Serial Number Suffix",
      type: "string",
      description:
        "Append a suffix to every entity serial number on this bridge. " +
        "Useful for forcing controllers like Aqara to treat devices as new " +
        "and bypass cached device data. Leave empty for default behavior.",
      maxLength: 16,
    },
    uniqueIdSuffix: {
      title: "Unique ID Suffix",
      type: "string",
      description:
        "Mixed into the unique ID of every bridged device on this bridge " +
        "(standard bridge mode). Controllers like Alexa cache device records " +
        "keyed on the unique ID, so setting or changing this can help mint " +
        "fresh identities. Applies after a bridge restart, then re-discover " +
        "in the controller. Leave empty for default behavior.",
      maxLength: 16,
    },
    sessionMaxAgeHours: {
      title: "Session Rotation Max Age (hours)",
      type: "number",
      description:
        "Rotate matter sessions older than this many hours so controllers " +
        "re-establish and re-subscribe. Server Mode rotates every 4h by " +
        "default; standard bridges only rotate when you set a value here. " +
        "Set 0 to disable. Range 0 to 168. (#287)",
      minimum: 0,
      maximum: 168,
    },
    filter: homeAssistantFilterSchema,
    featureFlags: featureFlagSchema,
  },
  required: ["name", "port", "filter"],
  additionalProperties: false,
};
