import type {
  ClimateAutoMode,
  CustomServiceArea,
  EntityMappingConfig,
  FanWindPresets,
  MatterDeviceType,
} from "./entity-mapping.js";
import type { HomeAssistantDomain } from "./home-assistant-domain.js";

export interface MappingProfileEntry {
  readonly domain: HomeAssistantDomain;
  readonly entityIdPattern?: string;
  readonly matterDeviceType?: MatterDeviceType;
  readonly customName?: string;
  readonly disabled?: boolean;
  readonly filterLifeEntity?: string;
  readonly cleaningModeEntity?: string;
  readonly temperatureEntity?: string;
  readonly humidityEntity?: string;
  readonly pressureEntity?: string;
  readonly batteryEntity?: string;
  readonly roomEntities?: string[];
  readonly disableLockPin?: boolean;
  readonly powerEntity?: string;
  readonly energyEntity?: string;
  readonly suctionLevelEntity?: string;
  readonly mopIntensityEntity?: string;
  readonly customServiceAreas?: CustomServiceArea[];
  readonly customFanSpeedTags?: Record<string, number>;
  /** Localized HA fan preset names that map to Matter wind modes (#387). */
  readonly fanWindPresets?: FanWindPresets;
  /** Restore the last fan speed when a controller turns the fan on, ignoring an injected value (Apple Home power button, #387). */
  readonly fanRestoreSpeedOnPowerOn?: boolean;
  readonly valetudoIdentifier?: string;
  readonly coverSwapOpenClose?: boolean;
  readonly coverSliderDebounceMs?: number;
  readonly disableClimateOnOff?: boolean;
  readonly disableClimateFanControl?: boolean;
  readonly climateKeepModeOnIdle?: boolean;
  readonly climateExposeFan?: boolean;
  readonly climateAutoMode?: ClimateAutoMode;
}

export interface MappingProfile {
  readonly version: 1;
  readonly name: string;
  readonly description?: string;
  readonly author?: string;
  readonly createdAt: string;
  readonly domains: HomeAssistantDomain[];
  readonly entryCount: number;
  readonly entries: MappingProfileEntry[];
}

export interface MappingProfileImportMatch {
  readonly entry: MappingProfileEntry;
  readonly matchedEntityId: string;
  readonly matchType: "exact" | "domain";
  readonly existingMapping?: EntityMappingConfig;
}

export interface MappingProfileImportPreview {
  readonly profileName: string;
  readonly totalEntries: number;
  readonly matches: MappingProfileImportMatch[];
  readonly unmatchedEntries: MappingProfileEntry[];
}

export interface MappingProfileImportRequest {
  readonly bridgeId: string;
  readonly profile: MappingProfile;
  readonly selectedEntityIds: string[];
}

export interface MappingProfileImportResult {
  readonly applied: number;
  readonly skipped: number;
  readonly errors: Array<{ entityId: string; error: string }>;
}
