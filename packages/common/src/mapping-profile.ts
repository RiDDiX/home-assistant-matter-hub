import type { EntityMappingConfig } from "./entity-mapping.js";
import type { HomeAssistantDomain } from "./home-assistant-domain.js";

export type MappingProfileEntry = Omit<EntityMappingConfig, "entityId"> & {
  readonly domain: HomeAssistantDomain;
  readonly entityIdPattern?: string;
};

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

export interface MappingProfileImportResult {
  readonly applied: number;
  readonly skipped: number;
  readonly errors: Array<{ entityId: string; error: string }>;
}
