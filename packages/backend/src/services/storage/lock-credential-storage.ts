import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  LockCredential,
  LockCredentialLegacy,
  LockCredentialRequest,
} from "@home-assistant-matter-hub/common";
import type { StorageContext, SupportedStorageTypes } from "@matter/main";
import { Service } from "../../core/ioc/service.js";
import type { AppStorage } from "./app-storage.js";

type StorageObjectType = { [key: string]: SupportedStorageTypes };

interface StoredCredentials {
  version: number;
  credentials: LockCredential[];
}

// Version 1: Plain text PIN (legacy)
// Version 2: Hashed PIN with PBKDF2
const CURRENT_VERSION = 2;

// PBKDF2 configuration for PIN hashing
const HASH_ITERATIONS = 100000;
const HASH_KEY_LENGTH = 64;
const HASH_ALGORITHM = "sha512";
const SALT_LENGTH = 32;

export class LockCredentialStorage extends Service {
  private storage!: StorageContext;
  private credentials: Map<string, LockCredential> = new Map();

  constructor(private readonly appStorage: AppStorage) {
    super("LockCredentialStorage");
  }

  protected override async initialize() {
    this.storage = this.appStorage.createContext("lock-credentials");
    await this.load();
  }

  private async load(): Promise<void> {
    const stored = await this.storage.get<StorageObjectType>("data", {
      version: CURRENT_VERSION,
      credentials: [],
    } as unknown as StorageObjectType);

    if (!stored || Object.keys(stored).length === 0) {
      return;
    }

    const data = stored as unknown as StoredCredentials;
    if (data.version !== CURRENT_VERSION) {
      await this.migrate(data);
      return;
    }

    for (const credential of data.credentials) {
      this.credentials.set(credential.entityId, credential);
    }
  }

  private async migrate(data: StoredCredentials): Promise<void> {
    // Migrate from v1 (plain text PIN) to v2 (hashed PIN)
    if (data.version === 1) {
      for (const legacyCredential of data.credentials as unknown as LockCredentialLegacy[]) {
        // Hash the plain text PIN during migration
        const salt = randomBytes(SALT_LENGTH).toString("hex");
        const hash = this.hashPin(legacyCredential.pinCode, salt);

        const credential: LockCredential = {
          entityId: legacyCredential.entityId,
          pinCodeHash: hash,
          pinCodeSalt: salt,
          name: legacyCredential.name,
          enabled: legacyCredential.enabled,
          createdAt: legacyCredential.createdAt,
          updatedAt: Date.now(),
        };
        this.credentials.set(credential.entityId, credential);
      }
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const data: StoredCredentials = {
      version: CURRENT_VERSION,
      credentials: Array.from(this.credentials.values()),
    };

    await this.storage.set("data", data as unknown as StorageObjectType);
  }

  /**
   * Hash a PIN using PBKDF2 with the given salt
   */
  private hashPin(pin: string, salt: string): string {
    return pbkdf2Sync(
      pin,
      salt,
      HASH_ITERATIONS,
      HASH_KEY_LENGTH,
      HASH_ALGORITHM,
    ).toString("hex");
  }

  /**
   * Verify a PIN against a stored credential
   * @returns true if the PIN matches, false otherwise
   */
  verifyPin(entityId: string, pin: string): boolean {
    const credential = this.credentials.get(entityId);
    if (!credential?.enabled) {
      return false;
    }
    const computed = Buffer.from(
      this.hashPin(pin, credential.pinCodeSalt),
      "hex",
    );
    const expected = Buffer.from(credential.pinCodeHash, "hex");
    if (computed.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(computed, expected);
  }

  /**
   * Check if a credential exists and is enabled for an entity
   */
  hasCredential(entityId: string): boolean {
    const credential = this.credentials.get(entityId);
    return !!credential?.enabled && !!credential.pinCodeHash;
  }

  /**
   * True if a user slot exists, even when no PIN was set yet
   * (Apple Home does SetUser before SetCredential)
   */
  hasUser(entityId: string): boolean {
    return this.credentials.has(entityId);
  }

  getAllCredentials(): LockCredential[] {
    return Array.from(this.credentials.values());
  }

  getCredential(entityId: string): LockCredential | undefined {
    return this.credentials.get(entityId);
  }

  getCredentialForEntity(entityId: string): LockCredential | undefined {
    return this.getCredential(entityId);
  }

  async setCredential(request: LockCredentialRequest): Promise<LockCredential> {
    const now = Date.now();
    const existing = this.credentials.get(request.entityId);

    // Generate new salt and hash the PIN
    const salt = randomBytes(SALT_LENGTH).toString("hex");
    const hash = this.hashPin(request.pinCode, salt);

    const credential: LockCredential = {
      entityId: request.entityId,
      pinCodeHash: hash,
      pinCodeSalt: salt,
      name: request.name?.trim() || existing?.name,
      enabled: request.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      userName: request.userName ?? existing?.userName,
      userUniqueId: request.userUniqueId ?? existing?.userUniqueId,
      creatorFabricIndex:
        existing?.creatorFabricIndex ?? request.creatorFabricIndex,
      lastModifiedFabricIndex:
        request.lastModifiedFabricIndex ??
        request.creatorFabricIndex ??
        existing?.lastModifiedFabricIndex,
    };

    this.credentials.set(request.entityId, credential);
    await this.persist();
    return credential;
  }

  /**
   * Upsert user metadata for an entity without changing the PIN. Used by the
   * Matter SetUser flow (Apple Home calls SetUser before SetCredential).
   */
  async setUser(params: {
    entityId: string;
    userName?: string;
    userUniqueId?: number;
    fabricIndex?: number;
  }): Promise<LockCredential> {
    const now = Date.now();
    const existing = this.credentials.get(params.entityId);
    const credential: LockCredential = {
      entityId: params.entityId,
      pinCodeHash: existing?.pinCodeHash ?? "",
      pinCodeSalt: existing?.pinCodeSalt ?? "",
      name: existing?.name,
      // A user slot without a PIN should not unlock anything, but it has to
      // exist so subsequent GetUser calls report Occupied.
      enabled: existing?.enabled ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      userName: params.userName ?? existing?.userName,
      userUniqueId: params.userUniqueId ?? existing?.userUniqueId,
      creatorFabricIndex: existing?.creatorFabricIndex ?? params.fabricIndex,
      lastModifiedFabricIndex:
        params.fabricIndex ?? existing?.lastModifiedFabricIndex,
    };
    this.credentials.set(params.entityId, credential);
    await this.persist();
    return credential;
  }

  async deleteCredential(entityId: string): Promise<void> {
    this.credentials.delete(entityId);
    await this.persist();
  }

  async deleteAllCredentials(): Promise<void> {
    this.credentials.clear();
    await this.persist();
  }

  /**
   * Toggle the enabled status of a credential without changing the PIN
   */
  async toggleEnabled(
    entityId: string,
    enabled: boolean,
  ): Promise<LockCredential | undefined> {
    const existing = this.credentials.get(entityId);
    if (!existing) {
      return undefined;
    }

    const updated: LockCredential = {
      ...existing,
      enabled,
      updatedAt: Date.now(),
    };

    this.credentials.set(entityId, updated);
    await this.persist();
    return updated;
  }
}
