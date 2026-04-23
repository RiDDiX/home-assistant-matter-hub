import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { StandaloneDeviceData } from "@home-assistant-matter-hub/common/src/standalone-device-data.js";
import type { StorageContext, SupportedStorageTypes } from "@matter/main";
import { Service } from "../../core/ioc/service.js";
import type { AppStorage } from "./app-storage.js";

type StorageObjectType = { [key: string]: SupportedStorageTypes };

// Scrypt parameters. N=16384 gives ~30-80 ms per verification on typical
// server hardware, which is acceptable for an admin basic-auth endpoint
// while still being expensive enough to slow brute-force attempts.
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST_N = 16384;
const SCRYPT_BLOCK_R = 8;
const SCRYPT_PARALLEL_P = 1;
const SALT_BYTES = 16;

export interface AuthInfo {
  username: string;
}

export interface AuthCredentials {
  username: string;
  password: string;
}

interface StoredAuth {
  username: string;
  // Legacy format: plaintext password stored directly. Migrated to hashed
  // form on first successful verification.
  password?: string;
  // Current format: scrypt hash + random salt, both hex-encoded.
  passwordHash?: string;
  passwordSalt?: string;
}

export interface BackupSettings {
  autoBackup: boolean;
  backupRetentionCount: number;
}

const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  autoBackup: true,
  backupRetentionCount: 5,
};

interface StoredSettings {
  auth?: StoredAuth;
  backup?: Partial<BackupSettings>;
}

function hashPassword(plain: string): {
  passwordHash: string;
  passwordSalt: string;
} {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST_N,
    r: SCRYPT_BLOCK_R,
    p: SCRYPT_PARALLEL_P,
  });
  return {
    passwordHash: derived.toString("hex"),
    passwordSalt: salt.toString("hex"),
  };
}

function verifyPasswordHash(
  plain: string,
  passwordHash: string,
  passwordSalt: string,
): boolean {
  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(passwordHash, "hex");
    salt = Buffer.from(passwordSalt, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN || salt.length === 0) {
    return false;
  }
  const derived = scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST_N,
    r: SCRYPT_BLOCK_R,
    p: SCRYPT_PARALLEL_P,
  });
  return timingSafeEqual(derived, expected);
}

function constantTimeStringEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison against bufA to mask timing differences.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export class AppSettingsStorage extends Service {
  private storage!: StorageContext;
  private settings: StoredSettings = {};
  // Caches the last plaintext password that was successfully verified
  // against the stored hash, keyed by username. This lets repeated basic-auth
  // calls avoid re-running scrypt on every HTTP request without persisting
  // the plaintext to disk.
  private verifiedPassword: { username: string; password: string } | null =
    null;

  constructor(private readonly appStorage: AppStorage) {
    super("AppSettingsStorage");
  }

  protected override async initialize() {
    this.storage = this.appStorage.createContext("settings");
    const stored = await this.storage.get<StorageObjectType>(
      "data",
      {} as StorageObjectType,
    );
    this.settings = (stored as unknown as StoredSettings) ?? {};
  }

  get auth(): AuthInfo | undefined {
    if (!this.settings.auth) {
      return undefined;
    }
    return { username: this.settings.auth.username };
  }

  async setAuth(credentials: AuthCredentials | undefined): Promise<void> {
    if (!credentials) {
      this.settings.auth = undefined;
      this.verifiedPassword = null;
    } else {
      const { passwordHash, passwordSalt } = hashPassword(credentials.password);
      this.settings.auth = {
        username: credentials.username,
        passwordHash,
        passwordSalt,
      };
      this.verifiedPassword = {
        username: credentials.username,
        password: credentials.password,
      };
    }
    await this.persist();
  }

  verifyAuth(username: string, password: string): boolean {
    const stored = this.settings.auth;
    if (!stored) {
      return false;
    }
    if (!constantTimeStringEquals(username, stored.username)) {
      return false;
    }

    // Fast path: avoid re-running scrypt for a plaintext we already verified.
    if (
      this.verifiedPassword &&
      this.verifiedPassword.username === stored.username &&
      constantTimeStringEquals(password, this.verifiedPassword.password)
    ) {
      return true;
    }

    // Legacy plaintext entry written by an older version. Verify against it
    // and opportunistically migrate to the hashed form on success.
    if (stored.password !== undefined) {
      const matches = constantTimeStringEquals(password, stored.password);
      if (matches) {
        this.verifiedPassword = { username: stored.username, password };
        void this.migrateLegacyPlaintext(password);
      }
      return matches;
    }

    if (stored.passwordHash && stored.passwordSalt) {
      if (
        verifyPasswordHash(password, stored.passwordHash, stored.passwordSalt)
      ) {
        this.verifiedPassword = { username: stored.username, password };
        return true;
      }
    }

    return false;
  }

  private async migrateLegacyPlaintext(plain: string): Promise<void> {
    const current = this.settings.auth;
    if (!current || current.password === undefined) {
      return;
    }
    const { passwordHash, passwordSalt } = hashPassword(plain);
    this.settings.auth = {
      username: current.username,
      passwordHash,
      passwordSalt,
    };
    try {
      await this.persist();
    } catch {
      // Best-effort migration; keep the cached plaintext so subsequent
      // verifications still succeed even if the write failed.
    }
  }

  get backupSettings(): BackupSettings {
    return { ...DEFAULT_BACKUP_SETTINGS, ...this.settings.backup };
  }

  async setBackupSettings(settings: Partial<BackupSettings>): Promise<void> {
    this.settings.backup = { ...this.settings.backup, ...settings };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.storage.set(
      "data",
      this.settings as unknown as StorageObjectType,
    );
  }
}
