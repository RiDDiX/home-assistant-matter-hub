import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { DoorLockServer as Base } from "@matter/main/behaviors";
import { DoorLock } from "@matter/main/clusters";
import { StatusCode, StatusResponseError } from "@matter/main/types";
import { LockCredentialStorage } from "../../services/storage/lock-credential-storage.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import LockState = DoorLock.LockState;

const logger = Logger.get("LockServer");

export interface LockServerConfig {
  getLockState: ValueGetter<LockState>;
  lock: ValueSetter<void>;
  unlock: ValueSetter<void>;
  unlatch?: ValueSetter<void>;
}

// Shared PIN credential helpers (used by both PinCredential variants)
function hasStoredCredentialHelper(
  env: { get: (type: typeof LockCredentialStorage) => LockCredentialStorage },
  entityId: string,
): boolean {
  try {
    const storage = env.get(LockCredentialStorage);
    return storage.hasCredential(entityId);
  } catch {
    return false;
  }
}

function verifyStoredPinHelper(
  env: { get: (type: typeof LockCredentialStorage) => LockCredentialStorage },
  entityId: string,
  pin: string,
): boolean {
  try {
    const storage = env.get(LockCredentialStorage);
    return storage.verifyPin(entityId, pin);
  } catch {
    return false;
  }
}

function buildGetUserResponse(
  env: { get: (type: typeof LockCredentialStorage) => LockCredentialStorage },
  entityId: string,
  userIndex: number,
): DoorLock.GetUserResponse {
  if (userIndex !== 1 || !hasStoredCredentialHelper(env, entityId)) {
    return {
      userIndex,
      userName: null,
      userUniqueId: null,
      userStatus: DoorLock.UserStatus.Available,
      userType: null,
      credentialRule: null,
      credentials: null,
      creatorFabricIndex: null,
      lastModifiedFabricIndex: null,
      nextUserIndex: null,
    };
  }
  return {
    userIndex: 1,
    userName: "PIN User",
    userUniqueId: 1,
    userStatus: DoorLock.UserStatus.OccupiedEnabled,
    userType: DoorLock.UserType.UnrestrictedUser,
    credentialRule: DoorLock.CredentialRule.Single,
    credentials: [
      { credentialType: DoorLock.CredentialType.Pin, credentialIndex: 1 },
    ],
    creatorFabricIndex: null,
    lastModifiedFabricIndex: null,
    nextUserIndex: null,
  };
}

/**
 * Base DoorLock server — used when no PIN is configured for the entity.
 * Plain lock/unlock, no credential workflow.
 */
// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class LockServerBase extends Base {
  declare state: LockServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    applyPatchState(this.state, {
      lockState: this.state.config.getLockState(entity.state, this.agent),
      lockType: DoorLock.LockType.DeadBolt,
      operatingMode: DoorLock.OperatingMode.Normal,
      actuatorEnabled: true,
      // Matter DoorLock bitmap: true = mode NOT supported (inverted semantics)
      supportedOperatingModes: {
        noRemoteLockUnlock: true,
        normal: false,
        passage: true,
        privacy: true,
        vacation: true,
      },
    });
  }

  override lockDoor() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.lock(void 0, this.agent);
    homeAssistant.callAction(action);
  }

  override unlockDoor() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.unlock(void 0, this.agent);
    homeAssistant.callAction(action);
  }
}

namespace LockServerBase {
  export class State extends Base.State {
    config!: LockServerConfig;
  }
}

/**
 * Extended DoorLock server with PinCredential feature.
 * Sets requirePinForRemoteOperation so Matter controllers (Google Home
 * in particular) prompt for the PIN in-app before unlock.
 *
 * Voice unlock stays disabled by Google policy — not a Matter limitation.
 */
const PinCredentialBase = Base.with(
  "User",
  "PinCredential",
  "CredentialOverTheAirAccess",
).set({
  wrongCodeEntryLimit: 3,
  userCodeTemporaryDisableTime: 10,
  numberOfTotalUsersSupported: 1,
  numberOfCredentialsSupportedPerUser: 1,
  credentialRulesSupport: { single: true, dual: false, tri: false },
});

// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class LockServerWithPinBase extends PinCredentialBase {
  declare state: LockServerWithPinBase.State;

  override async initialize() {
    // Set required PinCredential defaults BEFORE super.initialize() to prevent
    // "Behaviors have errors" validation failures
    if (this.state.numberOfPinUsersSupported === undefined) {
      this.state.numberOfPinUsersSupported = 1;
    }
    if (this.state.maxPinCodeLength === undefined) {
      this.state.maxPinCodeLength = 8;
    }
    if (this.state.minPinCodeLength === undefined) {
      this.state.minPinCodeLength = 4;
    }
    if (this.state.requirePinForRemoteOperation === undefined) {
      this.state.requirePinForRemoteOperation = false;
    }
    if (this.state.numberOfTotalUsersSupported === undefined) {
      this.state.numberOfTotalUsersSupported = 1;
    }
    if (this.state.numberOfCredentialsSupportedPerUser === undefined) {
      this.state.numberOfCredentialsSupportedPerUser = 1;
    }

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const isPinDisabledByMapping =
      homeAssistant.state.mapping?.disableLockPin === true;
    const hasPinConfigured =
      !isPinDisabledByMapping &&
      this.hasStoredCredential(homeAssistant.entityId);

    applyPatchState(this.state, {
      lockState: this.state.config.getLockState(entity.state, this.agent),
      lockType: DoorLock.LockType.DeadBolt,
      operatingMode: DoorLock.OperatingMode.Normal,
      actuatorEnabled: true,
      // Matter DoorLock bitmap: true = mode NOT supported (inverted semantics)
      supportedOperatingModes: {
        noRemoteLockUnlock: true,
        normal: false,
        passage: true,
        privacy: true,
        vacation: true,
      },
      numberOfPinUsersSupported: 1,
      numberOfTotalUsersSupported: 1,
      numberOfCredentialsSupportedPerUser: 1,
      maxPinCodeLength: 8,
      minPinCodeLength: 4,
      requirePinForRemoteOperation: hasPinConfigured,
    });
  }

  override lockDoor(request: DoorLock.LockDoorRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.lock(void 0, this.agent);

    // Log the lock request for debugging
    const hasPinProvided = !!request.pinCode;
    logger.debug(
      `lockDoor called for ${homeAssistant.entityId}, PIN provided: ${hasPinProvided}`,
    );

    // Lock does NOT require PIN validation - anyone can lock the door
    // We accept any PIN (or no PIN) and just proceed with the lock action
    // If a PIN was provided, pass it through to Home Assistant (some locks may need it)
    if (request.pinCode) {
      const providedPin = new TextDecoder().decode(request.pinCode);
      action.data = { ...action.data, code: providedPin };
    }

    homeAssistant.callAction(action);
  }

  override unlockDoor(request: DoorLock.UnlockDoorRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.unlock(void 0, this.agent);

    // Log the unlock request for debugging
    const hasPinProvided = !!request.pinCode;
    logger.debug(
      `unlockDoor called for ${homeAssistant.entityId}, PIN provided: ${hasPinProvided}, requirePin: ${this.state.requirePinForRemoteOperation}`,
    );

    // Validate provided PIN against stored hashed PIN
    if (this.state.requirePinForRemoteOperation) {
      if (!request.pinCode) {
        logger.info(
          `unlockDoor REJECTED for ${homeAssistant.entityId} - no PIN provided`,
        );
        throw new StatusResponseError(
          "PIN code required for remote unlock",
          StatusCode.Failure,
        );
      }
      const providedPin = new TextDecoder().decode(request.pinCode);
      if (!this.verifyStoredPin(homeAssistant.entityId, providedPin)) {
        logger.info(
          `unlockDoor REJECTED for ${homeAssistant.entityId} - invalid PIN`,
        );
        throw new StatusResponseError("Invalid PIN code", StatusCode.Failure);
      }
      logger.debug(`unlockDoor PIN verified for ${homeAssistant.entityId}`);
      // Pass the provided PIN to Home Assistant (for locks that require it)
      action.data = { ...action.data, code: providedPin };
    }

    homeAssistant.callAction(action);
  }

  /**
   * Check if a PIN credential exists and is enabled for an entity
   */
  protected hasStoredCredential(entityId: string): boolean {
    return hasStoredCredentialHelper(this.env, entityId);
  }

  /**
   * Verify a PIN against the stored hashed credential
   */
  protected verifyStoredPin(entityId: string, pin: string): boolean {
    return verifyStoredPinHelper(this.env, entityId, pin);
  }

  override getUser(request: DoorLock.GetUserRequest): DoorLock.GetUserResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    return buildGetUserResponse(
      this.env,
      homeAssistant.entityId,
      request.userIndex,
    );
  }

  override async setUser(): Promise<void> {
    // Users are managed via the entity mapping UI, not via Matter commands
  }

  override async clearUser(request: DoorLock.ClearUserRequest): Promise<void> {
    if (request.userIndex === 1 || request.userIndex === 0xfffe) {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const storage = this.env.get(LockCredentialStorage);
      await storage.deleteCredential(homeAssistant.entityId);
    }
  }

  override async setCredential(
    request: DoorLock.SetCredentialRequest,
  ): Promise<DoorLock.SetCredentialResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (
      request.credential.credentialType !== DoorLock.CredentialType.Pin ||
      request.credential.credentialIndex !== 1
    ) {
      return {
        status: 0x01 as never,
        userIndex: null,
        nextCredentialIndex: null,
      };
    }
    if (request.credentialData) {
      const pinCode = new TextDecoder().decode(request.credentialData);
      const storage = this.env.get(LockCredentialStorage);
      await storage.setCredential({
        entityId: homeAssistant.entityId,
        pinCode,
        name: "User 1",
        enabled: true,
      });
    }
    return { status: 0x00 as never, userIndex: 1, nextCredentialIndex: null };
  }

  override getCredentialStatus(
    request: DoorLock.GetCredentialStatusRequest,
  ): DoorLock.GetCredentialStatusResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (
      request.credential.credentialType !== DoorLock.CredentialType.Pin ||
      request.credential.credentialIndex !== 1
    ) {
      return {
        credentialExists: false,
        userIndex: null,
        creatorFabricIndex: null,
        lastModifiedFabricIndex: null,
        nextCredentialIndex: null,
      };
    }
    const exists = hasStoredCredentialHelper(this.env, homeAssistant.entityId);
    return {
      credentialExists: exists,
      userIndex: exists ? 1 : null,
      creatorFabricIndex: null,
      lastModifiedFabricIndex: null,
      nextCredentialIndex: null,
    };
  }

  override async clearCredential(
    request: DoorLock.ClearCredentialRequest,
  ): Promise<void> {
    if (
      request.credential === null ||
      request.credential.credentialType === DoorLock.CredentialType.Pin
    ) {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const storage = this.env.get(LockCredentialStorage);
      await storage.deleteCredential(homeAssistant.entityId);
    }
  }
}

namespace LockServerWithPinBase {
  export class State extends PinCredentialBase.State {
    config!: LockServerConfig;
  }
}

/**
 * Creates a basic LockServer without PIN credential support.
 * Use this when no PIN is configured for the entity.
 */
export function LockServer(config: LockServerConfig) {
  return LockServerBase.set({ config });
}

/**
 * LockServer with PIN credential support. Sets requirePinForRemoteOperation
 * so Matter controllers prompt for the PIN before remote unlock. Voice
 * unlock stays disabled by Google policy for Matter locks.
 */
export function LockServerWithPin(config: LockServerConfig) {
  return LockServerWithPinBase.set({ config });
}

/**
 * Extended DoorLock server with PinCredential + Unbolting features.
 * Adds unboltDoor command (unlatch) in addition to lock/unlock.
 * Used when the HA lock entity supports the OPEN feature.
 *
 * Apple Home shows an "Unlatch" button when this feature is present.
 */
const PinCredentialUnboltBase = Base.with(
  "User",
  "PinCredential",
  "CredentialOverTheAirAccess",
  "Unbolting",
).set({
  wrongCodeEntryLimit: 3,
  userCodeTemporaryDisableTime: 10,
  numberOfTotalUsersSupported: 1,
  numberOfCredentialsSupportedPerUser: 1,
  credentialRulesSupport: { single: true, dual: false, tri: false },
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the factory function below
class LockServerWithPinAndUnboltBase extends PinCredentialUnboltBase {
  declare state: LockServerWithPinAndUnboltBase.State;

  override async initialize() {
    if (this.state.numberOfPinUsersSupported === undefined) {
      this.state.numberOfPinUsersSupported = 1;
    }
    if (this.state.maxPinCodeLength === undefined) {
      this.state.maxPinCodeLength = 8;
    }
    if (this.state.minPinCodeLength === undefined) {
      this.state.minPinCodeLength = 4;
    }
    if (this.state.requirePinForRemoteOperation === undefined) {
      this.state.requirePinForRemoteOperation = false;
    }
    if (this.state.numberOfTotalUsersSupported === undefined) {
      this.state.numberOfTotalUsersSupported = 1;
    }
    if (this.state.numberOfCredentialsSupportedPerUser === undefined) {
      this.state.numberOfCredentialsSupportedPerUser = 1;
    }

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const isPinDisabledByMapping =
      homeAssistant.state.mapping?.disableLockPin === true;
    const hasPinConfigured =
      !isPinDisabledByMapping &&
      hasStoredCredentialHelper(this.env, homeAssistant.entityId);

    applyPatchState(this.state, {
      lockState: this.state.config.getLockState(entity.state, this.agent),
      lockType: DoorLock.LockType.DeadBolt,
      operatingMode: DoorLock.OperatingMode.Normal,
      actuatorEnabled: true,
      // Matter DoorLock bitmap: true = mode NOT supported (inverted semantics)
      supportedOperatingModes: {
        noRemoteLockUnlock: true,
        normal: false,
        passage: true,
        privacy: true,
        vacation: true,
      },
      numberOfPinUsersSupported: 1,
      numberOfTotalUsersSupported: 1,
      numberOfCredentialsSupportedPerUser: 1,
      maxPinCodeLength: 8,
      minPinCodeLength: 4,
      requirePinForRemoteOperation: hasPinConfigured,
    });
  }

  override lockDoor(request: DoorLock.LockDoorRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.lock(void 0, this.agent);
    const hasPinProvided = !!request.pinCode;
    logger.debug(
      `lockDoor called for ${homeAssistant.entityId}, PIN provided: ${hasPinProvided}`,
    );
    if (request.pinCode) {
      const providedPin = new TextDecoder().decode(request.pinCode);
      action.data = { ...action.data, code: providedPin };
    }
    homeAssistant.callAction(action);
  }

  override unlockDoor(request: DoorLock.UnlockDoorRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    // Use unlatch action if available (lock.open = unlock + unlatch on most
    // locks) — Apple Home's unlock then also unlatches, matching Google Home.
    const unlatchConfig = this.state.config.unlatch;
    const action = unlatchConfig
      ? unlatchConfig(void 0, this.agent)
      : this.state.config.unlock(void 0, this.agent);
    const hasPinProvided = !!request.pinCode;
    logger.debug(
      `unlockDoor called for ${homeAssistant.entityId}, PIN provided: ${hasPinProvided}, requirePin: ${this.state.requirePinForRemoteOperation}, usingUnlatch: ${!!unlatchConfig}`,
    );
    if (this.state.requirePinForRemoteOperation) {
      if (!request.pinCode) {
        logger.info(
          `unlockDoor REJECTED for ${homeAssistant.entityId} - no PIN provided`,
        );
        throw new StatusResponseError(
          "PIN code required for remote unlock",
          StatusCode.Failure,
        );
      }
      const providedPin = new TextDecoder().decode(request.pinCode);
      if (
        !verifyStoredPinHelper(this.env, homeAssistant.entityId, providedPin)
      ) {
        logger.info(
          `unlockDoor REJECTED for ${homeAssistant.entityId} - invalid PIN`,
        );
        throw new StatusResponseError("Invalid PIN code", StatusCode.Failure);
      }
      logger.debug(`unlockDoor PIN verified for ${homeAssistant.entityId}`);
      action.data = { ...action.data, code: providedPin };
    }
    homeAssistant.callAction(action);
  }

  override unboltDoor(request: DoorLock.UnboltDoorRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const unlatchConfig = this.state.config.unlatch;
    if (!unlatchConfig) {
      // Fallback to unlock if unlatch not configured
      const action = this.state.config.unlock(void 0, this.agent);
      homeAssistant.callAction(action);
      return;
    }
    const action = unlatchConfig(void 0, this.agent);
    const hasPinProvided = !!request.pinCode;
    logger.debug(
      `unboltDoor called for ${homeAssistant.entityId}, PIN provided: ${hasPinProvided}, requirePin: ${this.state.requirePinForRemoteOperation}`,
    );
    if (this.state.requirePinForRemoteOperation) {
      if (!request.pinCode) {
        logger.info(
          `unboltDoor REJECTED for ${homeAssistant.entityId} - no PIN provided`,
        );
        throw new StatusResponseError(
          "PIN code required for remote unlatch",
          StatusCode.Failure,
        );
      }
      const providedPin = new TextDecoder().decode(request.pinCode);
      if (
        !verifyStoredPinHelper(this.env, homeAssistant.entityId, providedPin)
      ) {
        logger.info(
          `unboltDoor REJECTED for ${homeAssistant.entityId} - invalid PIN`,
        );
        throw new StatusResponseError("Invalid PIN code", StatusCode.Failure);
      }
      logger.debug(`unboltDoor PIN verified for ${homeAssistant.entityId}`);
      action.data = { ...action.data, code: providedPin };
    }
    homeAssistant.callAction(action);
  }

  override getUser(request: DoorLock.GetUserRequest): DoorLock.GetUserResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    return buildGetUserResponse(
      this.env,
      homeAssistant.entityId,
      request.userIndex,
    );
  }

  override async setUser(): Promise<void> {
    // Users are managed via the entity mapping UI, not via Matter commands
  }

  override async clearUser(request: DoorLock.ClearUserRequest): Promise<void> {
    if (request.userIndex === 1 || request.userIndex === 0xfffe) {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const storage = this.env.get(LockCredentialStorage);
      await storage.deleteCredential(homeAssistant.entityId);
    }
  }

  override async setCredential(
    request: DoorLock.SetCredentialRequest,
  ): Promise<DoorLock.SetCredentialResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (
      request.credential.credentialType !== DoorLock.CredentialType.Pin ||
      request.credential.credentialIndex !== 1
    ) {
      return {
        status: 0x01 as never,
        userIndex: null,
        nextCredentialIndex: null,
      };
    }
    if (request.credentialData) {
      const pinCode = new TextDecoder().decode(request.credentialData);
      const storage = this.env.get(LockCredentialStorage);
      await storage.setCredential({
        entityId: homeAssistant.entityId,
        pinCode,
        name: "User 1",
        enabled: true,
      });
    }
    return { status: 0x00 as never, userIndex: 1, nextCredentialIndex: null };
  }

  override getCredentialStatus(
    request: DoorLock.GetCredentialStatusRequest,
  ): DoorLock.GetCredentialStatusResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (
      request.credential.credentialType !== DoorLock.CredentialType.Pin ||
      request.credential.credentialIndex !== 1
    ) {
      return {
        credentialExists: false,
        userIndex: null,
        creatorFabricIndex: null,
        lastModifiedFabricIndex: null,
        nextCredentialIndex: null,
      };
    }
    const exists = hasStoredCredentialHelper(this.env, homeAssistant.entityId);
    return {
      credentialExists: exists,
      userIndex: exists ? 1 : null,
      creatorFabricIndex: null,
      lastModifiedFabricIndex: null,
      nextCredentialIndex: null,
    };
  }

  override async clearCredential(
    request: DoorLock.ClearCredentialRequest,
  ): Promise<void> {
    if (
      request.credential === null ||
      request.credential.credentialType === DoorLock.CredentialType.Pin
    ) {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const storage = this.env.get(LockCredentialStorage);
      await storage.deleteCredential(homeAssistant.entityId);
    }
  }
}

namespace LockServerWithPinAndUnboltBase {
  export class State extends PinCredentialUnboltBase.State {
    config!: LockServerConfig;
  }
}

/**
 * Creates a LockServer with PIN credential + Unbolting support.
 * Used when the HA lock entity supports the OPEN feature (unlatch).
 * Apple Home shows an "Unlatch" button when this is enabled.
 */
export function LockServerWithPinAndUnbolt(config: LockServerConfig) {
  return LockServerWithPinAndUnboltBase.set({ config });
}
