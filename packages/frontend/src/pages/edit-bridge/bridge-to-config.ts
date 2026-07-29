import type {
  BridgeConfig,
  BridgeDataWithMetadata,
} from "@home-assistant-matter-hub/common";

// Seeds the edit form from the loaded bridge. Optional fields are only
// included when set, so the RJSF schema defaults apply instead of an
// explicit undefined overriding them.
export function bridgeToConfig(bridge: BridgeDataWithMetadata): BridgeConfig {
  return {
    name: bridge.name,
    port: bridge.port,
    filter: bridge.filter,
    ...(bridge.countryCode != null && { countryCode: bridge.countryCode }),
    ...(bridge.featureFlags != null && { featureFlags: bridge.featureFlags }),
    ...(bridge.icon != null && { icon: bridge.icon }),
    ...(bridge.priority != null && { priority: bridge.priority }),
    ...(bridge.serialNumberSuffix != null && {
      serialNumberSuffix: bridge.serialNumberSuffix,
    }),
    ...(bridge.uniqueIdSuffix != null && {
      uniqueIdSuffix: bridge.uniqueIdSuffix,
    }),
    ...(bridge.sessionMaxAgeHours != null && {
      sessionMaxAgeHours: bridge.sessionMaxAgeHours,
    }),
  };
}
