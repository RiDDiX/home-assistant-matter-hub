import type { StorageContext, SupportedStorageTypes } from "@matter/main";
import { Service } from "../../core/ioc/service.js";
import type { AppStorage } from "./app-storage.js";

type StorageObjectType = { [key: string]: SupportedStorageTypes };

// One record per stable identity key (see identity-resolver). endpointId is the
// frozen matter.js endpoint id that preserves the persisted number, anchorEntityId
// is the entity_id the uniqueId/serialNumber hash to, lastEntityId is the entity_id
// last seen so a rename can be detected. missingSince is the ISO time the keyed
// entity first went absent from the FULL HA registry; it is the tombstone the
// manual orphan cleanup ages out (see orphan-cleanup.ts), cleared when the entity
// returns.
export interface IdentityRecord {
  endpointId: string;
  anchorEntityId: string;
  lastEntityId?: string;
  createdAt?: string;
  missingSince?: string;
}

interface StoredIdentities {
  version: number;
  identities: Record<string, Record<string, IdentityRecord>>;
}

// missingSince is an additive optional field: records are stored as opaque
// objects, so an old record without it loads with it undefined and a new record
// serialises it inline. That round-trips both ways, so no version bump / migrate
// is required and CURRENT_VERSION stays 1.
const CURRENT_VERSION = 1;

// Records are written on every seeding pass, so persist is debounced to coalesce
// the initial burst into a single write. dispose flushes any pending write.
const PERSIST_DEBOUNCE_MS = 500;

export class EntityIdentityStorage extends Service {
  private storage!: StorageContext;
  private identities: Map<string, Map<string, IdentityRecord>> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly appStorage: AppStorage) {
    super("EntityIdentityStorage");
  }

  protected override async initialize() {
    this.storage = this.appStorage.createContext("entity-identities");
    await this.load();
  }

  override async dispose(): Promise<void> {
    await this.flush();
  }

  private async load(): Promise<void> {
    const stored = await this.storage.get<StorageObjectType>("data", {
      version: CURRENT_VERSION,
      identities: {},
    } as unknown as StorageObjectType);

    if (!stored || Object.keys(stored).length === 0) {
      return;
    }

    const data = stored as unknown as StoredIdentities;
    if (data.version !== CURRENT_VERSION) {
      await this.migrate(data);
      return;
    }

    for (const [bridgeId, records] of Object.entries(data.identities)) {
      const bridgeMap = new Map<string, IdentityRecord>();
      for (const [key, record] of Object.entries(records)) {
        bridgeMap.set(key, record);
      }
      this.identities.set(bridgeId, bridgeMap);
    }
  }

  private async migrate(data: StoredIdentities): Promise<void> {
    if (data.version < CURRENT_VERSION) {
      for (const [bridgeId, records] of Object.entries(data.identities)) {
        const bridgeMap = new Map<string, IdentityRecord>();
        for (const [key, record] of Object.entries(records)) {
          bridgeMap.set(key, record);
        }
        this.identities.set(bridgeId, bridgeMap);
      }
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const data: StoredIdentities = {
      version: CURRENT_VERSION,
      identities: {},
    };

    for (const [bridgeId, bridgeMap] of this.identities) {
      const records: Record<string, IdentityRecord> = {};
      for (const [key, record] of bridgeMap) {
        records[key] = record;
      }
      data.identities[bridgeId] = records;
    }

    await this.storage.set("data", data as unknown as StorageObjectType);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  // Flush any pending debounced write, used on dispose and by tests.
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  getIdentity(bridgeId: string, key: string): IdentityRecord | undefined {
    return this.identities.get(bridgeId)?.get(key);
  }

  getBridgeIdentities(bridgeId: string): Map<string, IdentityRecord> {
    return this.identities.get(bridgeId) ?? new Map();
  }

  setIdentity(bridgeId: string, key: string, record: IdentityRecord): void {
    let bridgeMap = this.identities.get(bridgeId);
    if (!bridgeMap) {
      bridgeMap = new Map();
      this.identities.set(bridgeId, bridgeMap);
    }
    bridgeMap.set(key, record);
    this.schedulePersist();
  }

  async deleteBridgeIdentities(bridgeId: string): Promise<void> {
    this.identities.delete(bridgeId);
    await this.flush();
  }

  // Drop a single identity record. Used by the manual orphan cleanup after the
  // 7-day tombstone; flush immediately since it is a user-initiated deletion.
  async deleteIdentity(bridgeId: string, key: string): Promise<void> {
    const bridgeMap = this.identities.get(bridgeId);
    if (bridgeMap?.delete(key)) {
      await this.flush();
    }
  }

  // Stamp the tombstone the first time a record's entity is absent from HA. Keeps
  // the first-seen time on later passes and no-ops once stamped, so a steady
  // absence does not churn the debounced persist.
  markIdentityMissing(bridgeId: string, key: string, nowIso: string): void {
    const record = this.identities.get(bridgeId)?.get(key);
    if (!record || record.missingSince != null) return;
    record.missingSince = nowIso;
    this.schedulePersist();
  }

  // Clear the tombstone when the entity is present again. No-ops when there is
  // nothing to clear, so an all-present bridge writes nothing on refresh.
  clearIdentityMissing(bridgeId: string, key: string): void {
    const record = this.identities.get(bridgeId)?.get(key);
    if (!record || record.missingSince == null) return;
    delete record.missingSince;
    this.schedulePersist();
  }
}
