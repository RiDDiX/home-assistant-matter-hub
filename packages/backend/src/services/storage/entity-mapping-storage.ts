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
    const stored = await this.storage.get<StorageObjectType>(
      "data",
      { version: CURRENT_VERSION, mappings: {} } as unknown as StorageObjectType,
    );

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

    const config: EntityMappingConfig = {
      entityId: request.entityId,
      matterDeviceType: request.matterDeviceType,
      customName: request.customName?.trim() || undefined,
      disabled: request.disabled,
    };

    if (
      !config.matterDeviceType &&
      !config.customName &&
      config.disabled !== true
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
