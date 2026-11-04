import type { BridgeData } from "@home-assistant-matter-hub/common";
import type { StorageContext, SupportedStorageTypes } from "@matter/main";
import { pick } from "lodash-es";
import { Service } from "../../core/ioc/service.js";
import type { AppStorage } from "./app-storage.js";
import { migrateBridgeV1ToV2 } from "./migrations/bridge/v1-to-v2.js";
import { migrateBridgeV2ToV3 } from "./migrations/bridge/v2-to-v3.js";
import { migrateBridgeV3ToV4 } from "./migrations/bridge/v3-to-v4.js";
import { migrateBridgeV4ToV5 } from "./migrations/bridge/v4-to-v5.js";
import { migrateBridgeV5ToV6 } from "./migrations/bridge/v5-to-v6.js";

type StorageObjectType = { [key: string]: SupportedStorageTypes };

// Each step takes a whole store from the version it is keyed by to the next.
export const bridgeMigrations: Record<
  number,
  (storage: StorageContext) => Promise<number>
> = {
  1: migrateBridgeV1ToV2,
  2: migrateBridgeV2ToV3,
  3: migrateBridgeV3ToV4,
  4: migrateBridgeV4ToV5,
  5: migrateBridgeV5ToV6,
};
export const BRIDGE_SCHEMA_VERSION = 6;

// Bridge.data adds runtime state (status, pairing codes, fabrics) to the
// config. Only the config belongs in the store and in backups.
const bridgeDataKeys: Record<keyof BridgeData, true> = {
  id: true,
  name: true,
  port: true,
  filter: true,
  featureFlags: true,
  countryCode: true,
  icon: true,
  priority: true,
  serialNumberSuffix: true,
  uniqueIdSuffix: true,
  sessionMaxAgeHours: true,
  basicInformation: true,
};

export class BridgeStorage extends Service {
  private storage!: StorageContext;
  private _bridges: BridgeData[] = [];

  constructor(private readonly appStorage: AppStorage) {
    super("BridgeStorage");
  }

  protected override async initialize() {
    this.storage = this.appStorage.createContext("bridges");

    await this.migrate();

    const bridgeIds: string[] = await this.storage.get("ids", []);
    const bridges = await Promise.all(
      bridgeIds.map(async (bridgeId) =>
        this.storage.get<StorageObjectType | undefined>(bridgeId),
      ),
    );
    this._bridges = bridges
      .filter((b) => b !== undefined)
      .map((bridge) => bridge as unknown as BridgeData);
  }

  get bridges(): ReadonlyArray<BridgeData> {
    return this._bridges;
  }

  async add(data: BridgeData): Promise<void> {
    const bridge = pick(data, Object.keys(bridgeDataKeys)) as BridgeData;
    const idx = this._bridges.findIndex((b) => b.id === bridge.id);
    if (idx !== -1) {
      this._bridges[idx] = bridge;
    } else {
      this._bridges.push(bridge);
    }
    // Ids first: load skips an id without a record, but never finds a record
    // the ids list does not name.
    await this.persistIds();
    await this.storage.set(bridge.id, bridge as unknown as StorageObjectType);
  }

  async remove(bridgeId: string): Promise<void> {
    const idx = this._bridges.findIndex((b) => b.id === bridgeId);
    if (idx >= 0) {
      this._bridges.splice(idx, 1);
    }
    await this.storage.delete(bridgeId);
    await this.persistIds();
  }

  private async persistIds() {
    await this.storage.set(
      "ids",
      this._bridges.map((b) => b.id),
    );
  }

  private async migrate(): Promise<void> {
    let version = await this.storage.get<number>("version", 1);
    while (bridgeMigrations[version]) {
      version = await bridgeMigrations[version](this.storage);
      await this.storage.set("version", version);
    }
  }
}
