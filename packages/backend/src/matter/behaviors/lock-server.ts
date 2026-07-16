import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { DoorLockServer as Base } from "@matter/main/behaviors";
import { DoorLock } from "@matter/main/clusters";
import {
  FabricIndex,
  Status,
  StatusCode,
  StatusResponseError,
} from "@matter/main/types";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
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

// Apple Home and other Matter controllers may pass credentialIndex 0 in the
// SetCredential request when asking the lock to allocate a free slot. We only
// support one PIN slot, so map 0 and 1 to the same physical slot.
export const SUPPORTED_SLOT = 1;

export function normalizeSupportedIndex(
  index: number | null | undefined,
): typeof SUPPORTED_SLOT | null {
  if (index === 0 || index === SUPPORTED_SLOT) {
    return SUPPORTED_SLOT;
  }
  return null;
}

/**
 * Opt-in passthrough that also programs the physical lock slot via an
 * integration-specific HA service when the PIN credential changes (#418).
 */
export interface UsercodePassthrough {
  service: string;
  slot: number;
  callAction: (action: HomeAssistantAction) => void;
}

// zha names the PIN field user_code, z-wave calls it usercode.
export function buildUsercodeSetAction(
  service: string,
  slot: number,
  pin: string,
): HomeAssistantAction {
  const pinKey = service.split(".")[0] === "zha" ? "user_code" : "usercode";
  return { action: service, data: { code_slot: slot, [pinKey]: pin } };
}

export function buildUsercodeClearAction(
  service: string,
  slot: number,
): HomeAssistantAction {
  return {
    action: service.replace(".set_", ".clear_"),
    data: { code_slot: slot },
  };
}

// Reads the passthrough config off the entity mapping. Undefined = feature off.
function usercodePassthroughFrom(
  homeAssistant: HomeAssistantEntityBehavior,
): UsercodePassthrough | undefined {
  const service = homeAssistant.state.mapping?.lockUsercodeService?.trim();
  if (!service) {
    return undefined;
  }
  return {
    service,
    slot: homeAssistant.state.mapping?.lockUsercodeSlot ?? 1,
    callAction: (action) => homeAssistant.callAction(action),
  };
}

type EnvLike = {
  get: (type: typeof LockCredentialStorage) => LockCredentialStorage;
};

function asFabricIndex(value: number | undefined): FabricIndex | null {
  return value === undefined || value === 0 ? null : FabricIndex(value);
}

// Shared PIN credential helpers (used by both PinCredential variants)
function hasStoredCredentialHelper(env: EnvLike, entityId: string): boolean {
  try {
    const storage = env.get(LockCredentialStorage);
    return storage.hasCredential(entityId);
  } catch {
    return false;
  }
}

function verifyStoredPinHelper(
  env: EnvLike,
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

export function buildGetUserResponse(
  env: EnvLike,
  entityId: string,
  userIndex: number,
): DoorLock.GetUserResponse {
  const slot = normalizeSupportedIndex(userIndex);
  const storage = (() => {
    try {
      return env.get(LockCredentialStorage);
    } catch {
      return undefined;
    }
  })();
  const credential = slot && storage?.getCredential(entityId);
  if (!slot || !credential) {
    return {
      userIndex: userIndex,
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
  const hasPin = !!credential.pinCodeHash && credential.enabled;
  return {
    userIndex: SUPPORTED_SLOT,
    userName: credential.userName ?? credential.name ?? "PIN User",
    userUniqueId: credential.userUniqueId ?? SUPPORTED_SLOT,
    userStatus: DoorLock.UserStatus.OccupiedEnabled,
    userType: DoorLock.UserType.UnrestrictedUser,
    credentialRule: DoorLock.CredentialRule.Single,
    credentials: hasPin
      ? [
          {
            credentialType: DoorLock.CredentialType.Pin,
            credentialIndex: SUPPORTED_SLOT,
          },
        ]
      : [],
    creatorFabricIndex: asFabricIndex(credential.creatorFabricIndex),
    lastModifiedFabricIndex: asFabricIndex(credential.lastModifiedFabricIndex),
    nextUserIndex: null,
  };
}

export function buildGetCredentialStatusResponse(
  env: EnvLike,
  entityId: string,
  request: DoorLock.GetCredentialStatusRequest,
): DoorLock.GetCredentialStatusResponse {
  const slot = normalizeSupportedIndex(request.credential.credentialIndex);
  if (
    request.credential.credentialType !== DoorLock.CredentialType.Pin ||
    !slot
  ) {
    return {
      credentialExists: false,
      userIndex: null,
      creatorFabricIndex: null,
      lastModifiedFabricIndex: null,
      nextCredentialIndex: null,
    };
  }
  const storage = (() => {
    try {
      return env.get(LockCredentialStorage);
    } catch {
      return undefined;
    }
  })();
  const credential = storage?.getCredential(entityId);
  const exists =
    !!credential?.enabled &&
    !!credential.pinCodeHash &&
    credential.pinCodeHash.length > 0;
  return {
    credentialExists: exists,
    userIndex: exists ? SUPPORTED_SLOT : null,
    creatorFabricIndex: exists
      ? asFabricIndex(credential?.creatorFabricIndex)
      : null,
    lastModifiedFabricIndex: exists
      ? asFabricIndex(credential?.lastModifiedFabricIndex)
      : null,
    nextCredentialIndex: null,
  };
}

/**
 * Apply Matter SetCredential to storage. Accepts credentialIndex 0 (free slot
 * allocation) or 1, both stored in the single supported slot. Returns the
 * response payload to forward to the controller.
 */
export async function applySetCredential(
  env: EnvLike,
  entityId: string,
  request: DoorLock.SetCredentialRequest,
  fabricIndex: number | undefined,
  passthrough?: UsercodePassthrough,
): Promise<DoorLock.SetCredentialResponse> {
  if (
    request.credential.credentialType !== DoorLock.CredentialType.Pin ||
    normalizeSupportedIndex(request.credential.credentialIndex) === null
  ) {
    return {
      status: Status.Failure,
      userIndex: null,
      nextCredentialIndex: null,
    };
  }
  const userSlot = normalizeSupportedIndex(request.userIndex ?? SUPPORTED_SLOT);
  if (userSlot === null) {
    return {
      status: Status.Failure,
      userIndex: null,
      nextCredentialIndex: null,
    };
  }
  if (request.credentialData) {
    const pinCode = new TextDecoder().decode(request.credentialData);
    const storage = env.get(LockCredentialStorage);
    await storage.setCredential({
      entityId,
      pinCode,
      enabled: true,
      lastModifiedFabricIndex: fabricIndex,
      creatorFabricIndex: fabricIndex,
    });
    // Fire and forget: a failed physical program still reports success.
    passthrough?.callAction(
      buildUsercodeSetAction(passthrough.service, passthrough.slot, pinCode),
    );
  }
  return {
    status: Status.Success,
    userIndex: SUPPORTED_SLOT,
    nextCredentialIndex: null,
  };
}

/**
 * Apply Matter SetUser to storage. Apple Home calls this before SetCredential
 * during access-code setup, so we have to make the slot occupied even before
 * any PIN exists.
 */
export async function applySetUser(
  env: EnvLike,
  entityId: string,
  request: DoorLock.SetUserRequest,
  fabricIndex: number | undefined,
): Promise<void> {
  if (normalizeSupportedIndex(request.userIndex) === null) {
    throw new StatusResponseError("Invalid user index", StatusCode.Failure);
  }
  const storage = env.get(LockCredentialStorage);
  await storage.setUser({
    entityId,
    userName: request.userName ?? undefined,
    userUniqueId: request.userUniqueId ?? undefined,
    fabricIndex,
  });
}

export async function applyClearCredential(
  env: EnvLike,
  entityId: string,
  request: DoorLock.ClearCredentialRequest,
  passthrough?: UsercodePassthrough,
): Promise<void> {
  if (request.credential === null) {
    const storage = env.get(LockCredentialStorage);
    await storage.deleteCredential(entityId);
    passthrough?.callAction(
      buildUsercodeClearAction(passthrough.service, passthrough.slot),
    );
    return;
  }
  if (
    request.credential.credentialType === DoorLock.CredentialType.Pin &&
    normalizeSupportedIndex(request.credential.credentialIndex) !== null
  ) {
    const storage = env.get(LockCredentialStorage);
    await storage.deleteCredential(entityId);
    passthrough?.callAction(
      buildUsercodeClearAction(passthrough.service, passthrough.slot),
    );
  }
}

/**
 * Apply Matter ClearUser to storage. Handles the single supported slot and the
 * 0xFFFE clear-all index. When a PIN credential was actually stored we also
 * clear the physical slot, so ClearUser can't leave a working code on the lock.
 */
export async function applyClearUser(
  env: EnvLike,
  entityId: string,
  request: DoorLock.ClearUserRequest,
  passthrough?: UsercodePassthrough,
): Promise<void> {
  const slot = normalizeSupportedIndex(request.userIndex);
  if (slot === null && request.userIndex !== 0xfffe) {
    return;
  }
  const storage = env.get(LockCredentialStorage);
  const hadCredential = storage.hasCredential(entityId);
  await storage.deleteCredential(entityId);
  if (hadCredential) {
    passthrough?.callAction(
      buildUsercodeClearAction(passthrough.service, passthrough.slot),
    );
  }
}

/**
 * Base DoorLock server, used when no PIN is configured for the entity.
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
    if (!entity.state || !entity.state.attributes) {
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
        // AlwaysSet (bits 5-15) is mandatory per the Matter spec; matter.js
        // requires supportedOperatingModes.alwaysSet to be 2047.
        alwaysSet: 2047,
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
 * Voice unlock stays disabled by Google policy, not a Matter limitation.
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
    if (!entity.state || !entity.state.attributes) {
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
        // AlwaysSet (bits 5-15) is mandatory per the Matter spec; matter.js
        // requires supportedOperatingModes.alwaysSet to be 2047.
        alwaysSet: 2047,
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

    // Lock does NOT require PIN validation - anyone can lock the door.
    // We accept any PIN (or no PIN) and proceed with the lock action.
    // If a PIN was provided, pass it through to Home Assistant (some locks
    // require it).
    if (request.pinCode) {
      const providedPin = new TextDecoder().decode(request.pinCode);
      action.data = { ...action.data, code: providedPin };
    }

    homeAssistant.callAction(action);
  }

  override unlockDoor(request: DoorLock.UnlockDoorRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.unlock(void 0, this.agent);

    const hasPinProvided = !!request.pinCode;
    logger.debug(
      `unlockDoor called for ${homeAssistant.entityId}, PIN provided: ${hasPinProvided}, requirePin: ${this.state.requirePinForRemoteOperation}`,
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

  override getUser(request: DoorLock.GetUserRequest): DoorLock.GetUserResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    return buildGetUserResponse(
      this.env,
      homeAssistant.entityId,
      request.userIndex,
    );
  }

  override async setUser(request: DoorLock.SetUserRequest): Promise<void> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    await applySetUser(
      this.env,
      homeAssistant.entityId,
      request,
      this.context.fabric,
    );
  }

  override async clearUser(request: DoorLock.ClearUserRequest): Promise<void> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    await applyClearUser(
      this.env,
      homeAssistant.entityId,
      request,
      usercodePassthroughFrom(homeAssistant),
    );
  }

  override async setCredential(
    request: DoorLock.SetCredentialRequest,
  ): Promise<DoorLock.SetCredentialResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    return applySetCredential(
      this.env,
      homeAssistant.entityId,
      request,
      this.context.fabric,
      usercodePassthroughFrom(homeAssistant),
    );
  }

  override getCredentialStatus(
    request: DoorLock.GetCredentialStatusRequest,
  ): DoorLock.GetCredentialStatusResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    return buildGetCredentialStatusResponse(
      this.env,
      homeAssistant.entityId,
      request,
    );
  }

  override async clearCredential(
    request: DoorLock.ClearCredentialRequest,
  ): Promise<void> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    await applyClearCredential(
      this.env,
      homeAssistant.entityId,
      request,
      usercodePassthroughFrom(homeAssistant),
    );
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
 * DoorLock server with PIN + Unbolting, for HA locks with the OPEN feature.
 * Unlock pulls the latch (lock.open), unbolt just retracts the bolt
 * (lock.unlock). Apple Home shows an "Unlatch" button when this is present.
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
    if (!entity.state || !entity.state.attributes) {
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
        // AlwaysSet (bits 5-15) is mandatory per the Matter spec; matter.js
        // requires supportedOperatingModes.alwaysSet to be 2047.
        alwaysSet: 2047,
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
    // locks), Apple Home's unlock then also unlatches, matching Google Home.
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
    // Unbolt pulls the bolt but not the latch, so unlock, not open (#397).
    const action = this.state.config.unlock(void 0, this.agent);
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

  override async setUser(request: DoorLock.SetUserRequest): Promise<void> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    await applySetUser(
      this.env,
      homeAssistant.entityId,
      request,
      this.context.fabric,
    );
  }

  override async clearUser(request: DoorLock.ClearUserRequest): Promise<void> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    await applyClearUser(
      this.env,
      homeAssistant.entityId,
      request,
      usercodePassthroughFrom(homeAssistant),
    );
  }

  override async setCredential(
    request: DoorLock.SetCredentialRequest,
  ): Promise<DoorLock.SetCredentialResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    return applySetCredential(
      this.env,
      homeAssistant.entityId,
      request,
      this.context.fabric,
      usercodePassthroughFrom(homeAssistant),
    );
  }

  override getCredentialStatus(
    request: DoorLock.GetCredentialStatusRequest,
  ): DoorLock.GetCredentialStatusResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    return buildGetCredentialStatusResponse(
      this.env,
      homeAssistant.entityId,
      request,
    );
  }

  override async clearCredential(
    request: DoorLock.ClearCredentialRequest,
  ): Promise<void> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    await applyClearCredential(
      this.env,
      homeAssistant.entityId,
      request,
      usercodePassthroughFrom(homeAssistant),
    );
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
