import { Logger } from "@matter/general";
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

const logger = Logger.get("EntityIdentityStorage");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EntityIdentityStorage extends Service {
  private storage!: StorageContext;
  private identities: Map<string, Map<string, IdentityRecord>> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  // Only a change writes. A newer build's file is never written, and entries
  // this build could not read are written back as they were.
  private dirty = false;
  private newerFile = false;
  // Raw entries load skipped, written back as they were.
  private unreadableBridges = new Map<string, unknown>();
  private unreadableRecords = new Map<string, Map<string, unknown>>();

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
    if (data.version > CURRENT_VERSION) {
      // A file written by a newer build. Starting empty would let the next
      // write persist an empty set over it.
      this.newerFile = true;
      logger.warn(
        `Identity file has unsupported version ${data.version}, reading the records that look readable and not saving changes until the newer build runs again`,
      );
    }

    // Valid JSON of the wrong shape must not stop every bridge from starting.
    let skipped = 0;
    for (const [bridgeId, records] of Object.entries(data.identities ?? {})) {
      if (!isPlainObject(records)) {
        this.unreadableBridges.set(bridgeId, records);
        skipped++;
        continue;
      }
      const bridgeMap = new Map<string, IdentityRecord>();
      const raw = new Map<string, unknown>();
      for (const [key, record] of Object.entries(records)) {
        if (!isPlainObject(record) || typeof record.endpointId !== "string") {
          raw.set(key, record);
          skipped++;
          continue;
        }
        bridgeMap.set(key, record as unknown as IdentityRecord);
      }
      this.identities.set(bridgeId, bridgeMap);
      if (raw.size > 0) this.unreadableRecords.set(bridgeId, raw);
    }
    if (skipped > 0) {
      logger.warn(`Skipped ${skipped} unreadable identity entries`);
    }
  }

  private async persist(): Promise<void> {
    if (this.newerFile) return;
    const data: StoredIdentities = {
      version: CURRENT_VERSION,
      identities: {},
    };

    for (const [bridgeId, raw] of this.unreadableBridges) {
      data.identities[bridgeId] = raw as Record<string, IdentityRecord>;
    }
    for (const [bridgeId, bridgeMap] of this.identities) {
      const records = Object.fromEntries(
        this.unreadableRecords.get(bridgeId) ?? [],
      ) as Record<string, IdentityRecord>;
      for (const [key, record] of bridgeMap) {
        records[key] = record;
      }
      data.identities[bridgeId] = records;
    }

    this.dirty = false;
    try {
      await this.storage.set("data", data as unknown as StorageObjectType);
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      // Still dirty on failure, the next change or dispose writes again.
      this.persist().catch((e) =>
        logger.warn("Failed to persist entity identities:", e),
      );
    }, PERSIST_DEBOUNCE_MS);
  }

  // Flush any pending debounced write, used on dispose and by tests.
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) await this.persist();
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
      this.unreadableBridges.delete(bridgeId);
    }
    bridgeMap.set(key, record);
    this.unreadableRecords.get(bridgeId)?.delete(key);
    this.schedulePersist();
  }

  async deleteBridgeIdentities(bridgeId: string): Promise<void> {
    this.unreadableRecords.delete(bridgeId);
    const hadRaw = this.unreadableBridges.delete(bridgeId);
    if (this.identities.delete(bridgeId) || hadRaw) {
      this.dirty = true;
      await this.flush();
    }
  }

  // Drop a single identity record. Used by the manual orphan cleanup after the
  // 7-day tombstone; flush immediately since it is a user-initiated deletion.
  async deleteIdentity(bridgeId: string, key: string): Promise<void> {
    const bridgeMap = this.identities.get(bridgeId);
    if (bridgeMap?.delete(key)) {
      this.dirty = true;
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
