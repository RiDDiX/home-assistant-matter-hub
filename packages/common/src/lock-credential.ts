/**
 * Lock credential configuration for Matter DoorLock PIN support
 */
export interface LockCredential {
  /** The entity ID of the lock (e.g., lock.front_door) */
  entityId: string;
  /**
   * The hashed PIN code (PBKDF2 with salt). May be empty when the slot was
   * created by a Matter controller via SetUser before any SetCredential.
   */
  pinCodeHash: string;
  /** Salt used for PIN hashing. Empty when no PIN is set yet. */
  pinCodeSalt: string;
  /** Optional friendly name for this credential */
  name?: string;
  /** Whether this credential is enabled */
  enabled: boolean;
  /** Timestamp when this credential was created */
  createdAt: number;
  /** Timestamp when this credential was last updated */
  updatedAt: number;
  /** Matter user name set via SetUser, if any */
  userName?: string;
  /** Matter UserUniqueID set via SetUser, if any */
  userUniqueId?: number;
  /** Fabric index that originally created the slot */
  creatorFabricIndex?: number;
  /** Fabric index that last modified the slot */
  lastModifiedFabricIndex?: number;
}

/**
 * @deprecated Use LockCredential with pinCodeHash instead
 * Legacy credential format with plain text PIN (for migration)
 */
export interface LockCredentialLegacy {
  entityId: string;
  pinCode: string;
  name?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Request to create or update a lock credential
 */
export interface LockCredentialRequest {
  entityId: string;
  pinCode: string;
  name?: string;
  enabled?: boolean;
  userName?: string;
  userUniqueId?: number;
  creatorFabricIndex?: number;
  lastModifiedFabricIndex?: number;
}

/**
 * Sanitized credential shape returned by the REST API. The PIN hash and
 * salt are never sent to clients; only metadata plus a `hasPinCode` flag.
 * Matter controllers do not see this type, they interact with locks via
 * the Matter DoorLock cluster, which is handled server-side against the
 * full `LockCredential` entries in storage.
 */
export interface SanitizedLockCredential {
  entityId: string;
  name?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  hasPinCode: boolean;
}

/**
 * Response containing all lock credentials as sent over the HAMH web API.
 */
export interface LockCredentialsResponse {
  credentials: SanitizedLockCredential[];
}
