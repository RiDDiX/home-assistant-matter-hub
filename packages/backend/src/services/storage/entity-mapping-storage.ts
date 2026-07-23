import type {
  EntityMappingConfig,
  EntityMappingRequest,
} from "@home-assistant-matter-hub/common";
import type { StorageContext, SupportedStorageTypes } from "@matter/main";
import { Service } from "../../core/ioc/service.js";
import type { AppStorage } from "./app-storage.js";

type StorageObjectType = { [key: string]: SupportedStorageTypes };

interface StoredMappings {
  version: number;
  mappings: Record<string, EntityMappingConfig[]>;
}

const CURRENT_VERSION = 1;

export class EntityMappingStorage extends Service {
  private storage!: StorageContext;
  private mappings: Map<string, Map<string, EntityMappingConfig>> = new Map();

  constructor(private readonly appStorage: AppStorage) {
    super("EntityMappingStorage");
  }

  protected override async initialize() {
    this.storage = this.appStorage.createContext("entity-mappings");
    await this.load();
  }

  private async load(): Promise<void> {
    const stored = await this.storage.get<StorageObjectType>("data", {
      version: CURRENT_VERSION,
      mappings: {},
    } as unknown as StorageObjectType);

    if (!stored || Object.keys(stored).length === 0) {
      return;
    }

    const data = stored as unknown as StoredMappings;
    if (data.version !== CURRENT_VERSION) {
      await this.migrate(data);
      return;
    }

    for (const [bridgeId, configs] of Object.entries(data.mappings)) {
      const bridgeMap = new Map<string, EntityMappingConfig>();
      for (const config of configs) {
        bridgeMap.set(config.entityId, config);
      }
      this.mappings.set(bridgeId, bridgeMap);
    }
  }

  private async migrate(data: StoredMappings): Promise<void> {
    if (data.version < CURRENT_VERSION) {
      for (const [bridgeId, configs] of Object.entries(data.mappings)) {
        const bridgeMap = new Map<string, EntityMappingConfig>();
        for (const config of configs) {
          bridgeMap.set(config.entityId, config);
        }
        this.mappings.set(bridgeId, bridgeMap);
      }
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const data: StoredMappings = {
      version: CURRENT_VERSION,
      mappings: {},
    };

    for (const [bridgeId, bridgeMap] of this.mappings) {
      data.mappings[bridgeId] = Array.from(bridgeMap.values());
    }

    await this.storage.set("data", data as unknown as StorageObjectType);
  }

  getMappingsForBridge(bridgeId: string): EntityMappingConfig[] {
    const bridgeMap = this.mappings.get(bridgeId);
    return bridgeMap ? Array.from(bridgeMap.values()) : [];
  }

  getMapping(
    bridgeId: string,
    entityId: string,
  ): EntityMappingConfig | undefined {
    return this.mappings.get(bridgeId)?.get(entityId);
  }

  async setMapping(
    request: EntityMappingRequest,
  ): Promise<EntityMappingConfig> {
    let bridgeMap = this.mappings.get(request.bridgeId);
    if (!bridgeMap) {
      bridgeMap = new Map();
      this.mappings.set(request.bridgeId, bridgeMap);
    }

    // Filter roomEntities to only include non-empty strings
    const roomEntities = request.roomEntities?.filter((e) => e?.trim()) || [];

    const pinLengths = sanitizePinLengths(
      request.lockPinMinLength,
      request.lockPinMaxLength,
    );

    const config: EntityMappingConfig = {
      entityId: request.entityId,
      matterDeviceType: request.matterDeviceType,
      customName: request.customName?.trim() || undefined,
      customProductName: request.customProductName?.trim() || undefined,
      customVendorName: request.customVendorName?.trim() || undefined,
      customSerialNumber: request.customSerialNumber?.trim() || undefined,
      customVendorId: sanitizeVendorId(request.customVendorId),
      disabled: request.disabled,
      filterLifeEntity: request.filterLifeEntity?.trim() || undefined,
      cleaningModeEntity: request.cleaningModeEntity?.trim() || undefined,
      temperatureEntity: request.temperatureEntity?.trim() || undefined,
      humidityEntity: request.humidityEntity?.trim() || undefined,
      batteryEntity: request.batteryEntity?.trim() || undefined,
      chargingStateEntity: request.chargingStateEntity?.trim() || undefined,
      roomEntities: roomEntities.length > 0 ? roomEntities : undefined,
      disableLockPin: request.disableLockPin || undefined,
      lockUsercodeService: request.lockUsercodeService?.trim() || undefined,
      lockUsercodeSlot: sanitizeUsercodeSlot(request.lockUsercodeSlot),
      lockPinMinLength: pinLengths.min,
      lockPinMaxLength: pinLengths.max,
      powerEntity: request.powerEntity?.trim() || undefined,
      energyEntity: request.energyEntity?.trim() || undefined,
      pressureEntity: request.pressureEntity?.trim() || undefined,
      suctionLevelEntity: request.suctionLevelEntity?.trim() || undefined,
      mopIntensityEntity: request.mopIntensityEntity?.trim() || undefined,
      customServiceAreas:
        request.customServiceAreas?.filter(
          (a) => a.name?.trim() && a.service?.trim(),
        ) ?? undefined,
      customFanSpeedTags:
        request.customFanSpeedTags &&
        Object.keys(request.customFanSpeedTags).length > 0
          ? request.customFanSpeedTags
          : undefined,
      fanWindPresets:
        request.fanWindPresets &&
        ((request.fanWindPresets.natural?.length ?? 0) > 0 ||
          (request.fanWindPresets.sleep?.length ?? 0) > 0)
          ? request.fanWindPresets
          : undefined,
      fanRestoreSpeedOnPowerOn: request.fanRestoreSpeedOnPowerOn || undefined,
      currentRoomEntity: request.currentRoomEntity?.trim() || undefined,
      cleanedAreaEntity: request.cleanedAreaEntity?.trim() || undefined,
      disableCustomAreaRoomModes:
        request.disableCustomAreaRoomModes || undefined,
      valetudoIdentifier: request.valetudoIdentifier?.trim() || undefined,
      coverSwapOpenClose: request.coverSwapOpenClose || undefined,
      coverExposeAsDimmableLight:
        request.coverExposeAsDimmableLight || undefined,
      selectExposeAsSwitch: request.selectExposeAsSwitch || undefined,
      selectSwitchOnOption: request.selectSwitchOnOption || undefined,
      selectSwitchOffOption: request.selectSwitchOffOption || undefined,
      coverSliderDebounceMs: sanitizeDebounceMs(request.coverSliderDebounceMs),
      updateThrottleMs: sanitizeThrottleMs(request.updateThrottleMs),
      disableClimateOnOff: request.disableClimateOnOff || undefined,
      disableClimateFanControl: request.disableClimateFanControl || undefined,
      climateKeepModeOnIdle: request.climateKeepModeOnIdle || undefined,
      climateExposeFan: request.climateExposeFan || undefined,
      climateAutoMode: request.climateAutoMode || undefined,
      composedEntities:
        request.composedEntities?.filter((e) => e.entityId?.trim()) ??
        undefined,
    };

    if (
      !config.matterDeviceType &&
      !config.customName &&
      !config.customProductName &&
      !config.customVendorName &&
      !config.customSerialNumber &&
      config.customVendorId === undefined &&
      config.disabled !== true &&
      !config.filterLifeEntity &&
      !config.cleaningModeEntity &&
      !config.temperatureEntity &&
      !config.humidityEntity &&
      !config.batteryEntity &&
      !config.chargingStateEntity &&
      !config.roomEntities &&
      !config.disableLockPin &&
      !config.lockUsercodeService &&
      config.lockUsercodeSlot === undefined &&
      config.lockPinMinLength === undefined &&
      config.lockPinMaxLength === undefined &&
      !config.powerEntity &&
      !config.energyEntity &&
      !config.pressureEntity &&
      !config.suctionLevelEntity &&
      !config.mopIntensityEntity &&
      (!config.customServiceAreas || config.customServiceAreas.length === 0) &&
      (!config.customFanSpeedTags ||
        Object.keys(config.customFanSpeedTags).length === 0) &&
      (!config.fanWindPresets ||
        ((config.fanWindPresets.natural?.length ?? 0) === 0 &&
          (config.fanWindPresets.sleep?.length ?? 0) === 0)) &&
      !config.fanRestoreSpeedOnPowerOn &&
      !config.currentRoomEntity &&
      !config.cleanedAreaEntity &&
      !config.disableCustomAreaRoomModes &&
      !config.valetudoIdentifier &&
      !config.coverSwapOpenClose &&
      !config.coverExposeAsDimmableLight &&
      !config.selectExposeAsSwitch &&
      !config.selectSwitchOnOption &&
      !config.selectSwitchOffOption &&
      !config.coverSliderDebounceMs &&
      !config.updateThrottleMs &&
      !config.disableClimateOnOff &&
      !config.disableClimateFanControl &&
      !config.climateKeepModeOnIdle &&
      !config.climateExposeFan &&
      !config.climateAutoMode &&
      (!config.composedEntities || config.composedEntities.length === 0)
    ) {
      bridgeMap.delete(request.entityId);
    } else {
      bridgeMap.set(request.entityId, config);
    }

    await this.persist();
    return config;
  }

  async deleteMapping(bridgeId: string, entityId: string): Promise<void> {
    const bridgeMap = this.mappings.get(bridgeId);
    if (bridgeMap) {
      bridgeMap.delete(entityId);
      await this.persist();
    }
  }

  async deleteBridgeMappings(bridgeId: string): Promise<void> {
    this.mappings.delete(bridgeId);
    await this.persist();
  }
}

function sanitizeVendorId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 0xfffe) {
    return undefined;
  }
  return n;
}

function sanitizeUsercodeSlot(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    return undefined;
  }
  return n;
}

// PIN length attributes are uint8, the Matter spec keeps them 1..20. Reject
// anything outside that range rather than silently clamping (#418).
function sanitizePinLength(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 20) {
    return undefined;
  }
  return n;
}

// Drop both bounds when the effective range is impossible. A lone bound is
// checked against the default counterpart (4/8), otherwise min 15 with max
// unset would be stored while the lock still advertises the 4/8 fallback.
function sanitizePinLengths(
  min: unknown,
  max: unknown,
): { min: number | undefined; max: number | undefined } {
  const lo = sanitizePinLength(min);
  const hi = sanitizePinLength(max);
  if ((lo ?? 4) > (hi ?? 8)) {
    return { min: undefined, max: undefined };
  }
  return { min: lo, max: hi };
}

function sanitizeDebounceMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.min(5000, Math.round(n));
}

// Like the slider debounce but allows a longer window: a chatty sensor may want
// one report every several seconds. Capped at 60s.
function sanitizeThrottleMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.min(60000, Math.round(n));
}
