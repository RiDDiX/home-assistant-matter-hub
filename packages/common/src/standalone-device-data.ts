// @ts-expect-error
import type { HomeAssistantFilter } from "../home-assistant-filter";

export interface StandaloneDeviceConfig {
  readonly name: string;
  readonly port: number;
  readonly filter: HomeAssistantFilter;
  readonly deviceType: string; // Main device type (e.g., "light", "lock", etc.)
  readonly entities: string[]; // Entity IDs to expose as clusters
  readonly countryCode?: string;
  readonly icon?: string;
  readonly serialNumberSuffix?: string;

  // Robust entity-to-cluster mapping fields (mirroring bridge EntityMappingConfig)
  readonly temperatureEntity?: string;
  readonly humidityEntity?: string;
  readonly pressureEntity?: string;
  readonly batteryEntity?: string;
  readonly powerEntity?: string;
  readonly energyEntity?: string;
  readonly suctionLevelEntity?: string;
  readonly mopIntensityEntity?: string;
  readonly filterLifeEntity?: string;
  readonly cleaningModeEntity?: string;
  readonly roomEntities?: string[];
  readonly disableLockPin?: boolean;
  readonly customServiceAreas?: import("./entity-mapping.js").CustomServiceArea[];
  readonly customFanSpeedTags?: Record<string, number>;
  readonly currentRoomEntity?: string;
  readonly valetudoIdentifier?: string;
  readonly coverSwapOpenClose?: boolean;
}

export interface CreateStandaloneDeviceRequest extends StandaloneDeviceConfig {}

export interface UpdateStandaloneDeviceRequest extends StandaloneDeviceConfig {
  readonly id: string;
}

export interface StandaloneDeviceBasicInformation {
  vendorId: number;
  vendorName: string;
  productId: number;
  productName: string;
  productLabel: string;
  hardwareVersion: number;
  softwareVersion: number;
  hardwareVersionString?: string;
  softwareVersionString?: string;
}

export interface StandaloneDeviceData extends StandaloneDeviceConfig {
  readonly id: string;
  readonly basicInformation: StandaloneDeviceBasicInformation;
}
