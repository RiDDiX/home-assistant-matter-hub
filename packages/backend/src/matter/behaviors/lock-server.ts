import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger, Seconds, Time, type Timer, Timestamp } from "@matter/general";
import { DoorLockServer as Base } from "@matter/main/behaviors";
import { DoorLock } from "@matter/main/clusters";
import {
  FabricIndex,
  Status,
  StatusCode,
  StatusResponseError,
} from "@matter/main/types";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
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
  /**
   * Programs the physical lock and settles with it. The debounced fire and
   * forget path reported success to the controller while the lock had rejected
   * the code, which for a clear leaves a working keypad code behind.
   */
  program: (action: HomeAssistantAction) => Promise<void>;
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
    program: async (action) => {
      homeAssistant.assertAvailable();
      const [domain, name] = action.action.split(".");
      await homeAssistant.env
        .get(HomeAssistantActions)
        .callAction(domain, name, action.data, {
          entity_id: homeAssistant.entityId,
        });
    },
  };
}

// min/maxPinCodeLength are uint8, Matter spec keeps them 1..20.
const DEFAULT_MIN_PIN_LENGTH = 4;
const DEFAULT_MAX_PIN_LENGTH = 8;
const PIN_LENGTH_SPEC_MIN = 1;
const PIN_LENGTH_SPEC_MAX = 20;

function clampPinLength(value: number | undefined): number | undefined {
  if (
    value === undefined ||
    !Number.isInteger(value) ||
    value < PIN_LENGTH_SPEC_MIN ||
    value > PIN_LENGTH_SPEC_MAX
  ) {
    return undefined;
  }
  return value;
}

// Per-entity PIN length override (#418). A lock that wants an exact length sets
// min == max so controllers advertise the right bounds. Falls back to 4/8 when
// unset or inconsistent (min > max). The web API checks its PINs with it too.
export function effectivePinCodeLengths(
  mapping: { lockPinMinLength?: number; lockPinMaxLength?: number } | undefined,
): {
  min: number;
  max: number;
} {
  const min =
    clampPinLength(mapping?.lockPinMinLength) ?? DEFAULT_MIN_PIN_LENGTH;
  const max =
    clampPinLength(mapping?.lockPinMaxLength) ?? DEFAULT_MAX_PIN_LENGTH;
  if (min > max) {
    return { min: DEFAULT_MIN_PIN_LENGTH, max: DEFAULT_MAX_PIN_LENGTH };
  }
  return { min, max };
}

type EnvLike = {
  get: (type: typeof LockCredentialStorage) => LockCredentialStorage;
};

// Test stubs provide a bare storage object, so both the lookup and the signal
// are optional here.
function credentialChangesOf(env: EnvLike) {
  try {
    return env.get(LockCredentialStorage)?.changed;
  } catch {
    return undefined;
  }
}

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

/**
 * Whether a remote unlock has to carry a PIN. Read live from storage, not from
 * requirePinForRemoteOperation: that attribute is written by update(), which
 * only runs on a Home Assistant state change, so a PIN added or cleared through
 * a controller or the web API would not have been enforced until the entity
 * happened to change.
 */
function pinIsRequired(
  env: EnvLike,
  homeAssistant: HomeAssistantEntityBehavior,
): boolean {
  if (homeAssistant.state.mapping?.disableLockPin === true) {
    return false;
  }
  return hasStoredCredentialHelper(env, homeAssistant.entityId);
}

async function verifyStoredPinHelper(
  env: EnvLike,
  entityId: string,
  pin: string,
): Promise<boolean> {
  try {
    const storage = env.get(LockCredentialStorage);
    return await storage.verifyPin(entityId, pin);
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
  pinLengths: { min: number; max: number },
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
  // Add and Modify were treated the same, so Add silently overwrote an occupied
  // slot and any fabric could replace a PIN another fabric had created while
  // creatorFabricIndex kept naming the original one. Same statuses matter.js
  // uses in its own DoorLockServer.
  const storage = env.get(LockCredentialStorage);
  const existing = storage.getCredential(entityId);
  const slotTaken = !!existing?.pinCodeHash;
  if (request.operationType === DoorLock.DataOperationType.Add && slotTaken) {
    return {
      status: Status.Failure,
      userIndex: null,
      nextCredentialIndex: null,
    };
  }
  if (request.operationType === DoorLock.DataOperationType.Modify) {
    if (!slotTaken) {
      return {
        status: Status.InvalidCommand,
        userIndex: null,
        nextCredentialIndex: null,
      };
    }
    if (
      existing?.creatorFabricIndex !== undefined &&
      fabricIndex !== existing.creatorFabricIndex
    ) {
      return {
        status: Status.InvalidCommand,
        userIndex: null,
        nextCredentialIndex: null,
      };
    }
  }
  if (request.credentialData) {
    // An empty Uint8Array is truthy, so without this a controller could store a
    // zero length PIN. That PIN makes hasCredential true, which turns
    // requirePinForRemoteOperation on, and the empty PIN then satisfies it.
    // Check the octet count against the lengths this lock advertises.
    const length = request.credentialData.byteLength;
    if (length < pinLengths.min || length > pinLengths.max) {
      return {
        status: Status.InvalidCommand,
        userIndex: null,
        nextCredentialIndex: null,
      };
    }
    const pinCode = new TextDecoder().decode(request.credentialData);
    // Program the physical lock before storing, so a lock that rejects the code
    // fails the command instead of leaving a PIN the keypad does not know.
    if (passthrough) {
      try {
        await passthrough.program(
          buildUsercodeSetAction(
            passthrough.service,
            passthrough.slot,
            pinCode,
          ),
        );
      } catch (error) {
        logger.warn(
          `Programming the PIN on ${entityId} failed, credential not stored: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          status: Status.Failure,
          userIndex: null,
          nextCredentialIndex: null,
        };
      }
    }
    await storage.setCredential({
      entityId,
      pinCode,
      enabled: true,
      lastModifiedFabricIndex: fabricIndex,
      creatorFabricIndex: fabricIndex,
    });
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
  const existing = storage.getCredential(entityId);
  if (request.operationType === DoorLock.DataOperationType.Add && existing) {
    throw new StatusResponseError("User slot is occupied", StatusCode.Failure);
  }
  if (request.operationType === DoorLock.DataOperationType.Modify) {
    if (!existing) {
      throw new StatusResponseError(
        "User slot is available",
        StatusCode.InvalidCommand,
      );
    }
    // Only the fabric that created the slot may rename it, the same rule
    // matter.js applies.
    const renaming =
      (request.userName !== null && request.userName !== undefined) ||
      (request.userUniqueId !== null && request.userUniqueId !== undefined);
    if (
      renaming &&
      existing.creatorFabricIndex !== undefined &&
      fabricIndex !== existing.creatorFabricIndex
    ) {
      throw new StatusResponseError(
        "Cannot modify a user of a different fabric",
        StatusCode.InvalidCommand,
      );
    }
  }
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
    await clearStoredAndPhysical(env, entityId, passthrough);
    return;
  }
  if (
    request.credential.credentialType === DoorLock.CredentialType.Pin &&
    normalizeSupportedIndex(request.credential.credentialIndex) !== null
  ) {
    await clearStoredAndPhysical(env, entityId, passthrough);
  }
}

/**
 * Clear the keypad code first and only forget the stored one once that worked.
 * Reporting success on a failed clear leaves a code that still opens the door.
 */
async function clearStoredAndPhysical(
  env: EnvLike,
  entityId: string,
  passthrough: UsercodePassthrough | undefined,
): Promise<void> {
  if (passthrough) {
    try {
      await passthrough.program(
        buildUsercodeClearAction(passthrough.service, passthrough.slot),
      );
    } catch (error) {
      logger.warn(
        `Clearing the PIN on ${entityId} failed, credential kept: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new StatusResponseError(
        "Could not clear the PIN on the lock",
        StatusCode.Failure,
      );
    }
  }
  const storage = env.get(LockCredentialStorage);
  await storage.deleteCredential(entityId);
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
  await clearStoredAndPhysical(
    env,
    entityId,
    hadCredential ? passthrough : undefined,
  );
}

// UnlockWithTimeout relocks through HA once the timeout is up. The timer lives
// in matter.js' autoRelockTimer, which its DoorLockServer stops on close, and
// every later lock command clears or replaces it.
function scheduleRelock(
  server: {
    readonly internal: { autoRelockTimer?: Timer };
    readonly env: Base["env"];
    readonly agent: Base["agent"];
    readonly state: { config: LockServerConfig };
  },
  seconds = 0,
) {
  const { internal } = server;
  internal.autoRelockTimer?.stop();
  internal.autoRelockTimer = undefined;
  if (seconds === 0) {
    return;
  }
  const actions = server.env.get(HomeAssistantActions);
  const { entityId } = server.agent.get(HomeAssistantEntityBehavior);
  const lock = server.state.config.lock(void 0, server.agent);
  internal.autoRelockTimer = Time.getTimer("relock", Seconds(seconds), () =>
    actions.call(lock, entityId),
  ).start();
}

/**
 * DoorLock server without PIN or User, for lockWithoutPin (#418).
 * Plain lock/unlock, no credential workflow.
 */
// The bare matter.js DoorLockServer turns every feature on, PIN and User too.
const PlainBase = Base.with();

// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class LockServerBase extends PlainBase {
  declare state: LockServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { lock: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    applyPatchState(
      this.state,
      plainLockState(this.state.config, entity, this.agent),
    );
  }

  override lockDoor() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.lock(void 0, this.agent);
    homeAssistant.callAction(action);
    scheduleRelock(this);
  }

  override unlockDoor() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.unlock(void 0, this.agent);
    homeAssistant.callAction(action);
    scheduleRelock(this);
  }

  override unlockWithTimeout(request: DoorLock.UnlockWithTimeoutRequest) {
    this.unlockDoor();
    scheduleRelock(this, request.timeout);
  }
}

namespace LockServerBase {
  export class State extends PlainBase.State {
    config!: LockServerConfig;
  }
}

function plainLockState(
  config: LockServerConfig,
  entity: HomeAssistantEntityInformation,
  agent: Base["agent"],
) {
  return {
    lockState: config.getLockState(entity.state, agent),
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
  };
}

// Unbolting without PIN for locks with HA's OPEN feature and lockWithoutPin
// set (#418). Unlock opens the latch and unbolt only unlocks, like the PIN
// variant.
const UnboltBase = Base.with("Unbolting");

// biome-ignore lint/correctness/noUnusedVariables: used by the factory below
class LockServerWithUnboltBase extends UnboltBase {
  declare state: LockServerWithUnboltBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { lock: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    applyPatchState(
      this.state,
      plainLockState(this.state.config, entity, this.agent),
    );
  }

  override lockDoor() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(this.state.config.lock(void 0, this.agent));
    scheduleRelock(this);
  }

  override unlockDoor() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const unlatch = this.state.config.unlatch;
    homeAssistant.callAction(
      unlatch
        ? unlatch(void 0, this.agent)
        : this.state.config.unlock(void 0, this.agent),
    );
    scheduleRelock(this);
  }

  override unlockWithTimeout(request: DoorLock.UnlockWithTimeoutRequest) {
    this.unlockDoor();
    scheduleRelock(this, request.timeout);
  }

  override unboltDoor() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(this.state.config.unlock(void 0, this.agent));
    scheduleRelock(this);
  }
}

namespace LockServerWithUnboltBase {
  export class State extends UnboltBase.State {
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
// v2.0.7..v2.0.16 wrote sendPinOverTheAir=true for every lock and matter.js
// persisted it. With the User feature active the attribute is illegal
// (conformance [!USR & PIN]), so the stored leftover fails doorLock init on
// every start (#433). Clearing pre-initialize also deletes the stored key.
function clearStaleSendPinOverTheAir(state: object) {
  const s = state as { sendPinOverTheAir?: boolean };
  if (s.sendPinOverTheAir !== undefined) {
    s.sendPinOverTheAir = undefined;
  }
}

type PinLockServer = LockServerWithPinBase | LockServerWithPinAndUnboltBase;

// Required PinCredential defaults have to be in place before super.initialize(),
// or matter.js fails validation with "Behaviors have errors".
function applyPinDefaults(state: PinLockServer["state"]) {
  clearStaleSendPinOverTheAir(state);
  state.numberOfPinUsersSupported ??= 1;
  state.maxPinCodeLength ??= DEFAULT_MAX_PIN_LENGTH;
  state.minPinCodeLength ??= DEFAULT_MIN_PIN_LENGTH;
  state.requirePinForRemoteOperation ??= false;
  state.numberOfTotalUsersSupported ??= 1;
  state.numberOfCredentialsSupportedPerUser ??= 1;
}

function pinLockState(
  server: PinLockServer,
  entity: HomeAssistantEntityInformation,
) {
  const homeAssistant = server.agent.get(HomeAssistantEntityBehavior);
  const pinLengths = effectivePinCodeLengths(homeAssistant.state.mapping);
  return {
    ...plainLockState(server.state.config, entity, server.agent),
    numberOfPinUsersSupported: 1,
    numberOfTotalUsersSupported: 1,
    numberOfCredentialsSupportedPerUser: 1,
    maxPinCodeLength: pinLengths.max,
    minPinCodeLength: pinLengths.min,
    requirePinForRemoteOperation: pinIsRequired(server.env, homeAssistant),
  };
}

/**
 * The remote PIN gate of unlock, unlockWithTimeout and unbolt. matter.js counts
 * wrong codes and locks out in its private #authorize, which these overrides
 * never reach, so the same internal counter is kept here. Returns the PIN to
 * pass on to Home Assistant, undefined when the lock needs none.
 */
async function assertRemotePin(
  server: PinLockServer,
  pinCode: DoorLock.UnlockDoorRequest["pinCode"],
  operation: string,
): Promise<string | undefined> {
  const homeAssistant = server.agent.get(HomeAssistantEntityBehavior);
  const { entityId } = homeAssistant;
  if (!pinIsRequired(server.env, homeAssistant)) {
    return undefined;
  }
  const { internal } = server;
  if (
    internal.lockoutEndsAt !== undefined &&
    Time.nowMs < internal.lockoutEndsAt
  ) {
    logger.info(`${operation} REJECTED for ${entityId} - wrong code lockout`);
    throw new StatusResponseError(
      "Lock operations are ignored during the wrong code lockout",
      StatusCode.Failure,
    );
  }
  const pin = pinCode ? new TextDecoder().decode(pinCode) : undefined;
  if (
    pin !== undefined &&
    (await verifyStoredPinHelper(server.env, entityId, pin))
  ) {
    internal.wrongCodeCount = 0;
    logger.debug(`${operation} PIN verified for ${entityId}`);
    return pin;
  }
  logger.info(
    `${operation} REJECTED for ${entityId} - ${pin === undefined ? "no PIN provided" : "invalid PIN"}`,
  );
  // A missing PIN counts as a wrong one, as in matter.js.
  const { wrongCodeEntryLimit, userCodeTemporaryDisableTime } = server.state;
  if (
    wrongCodeEntryLimit !== undefined &&
    userCodeTemporaryDisableTime !== undefined &&
    ++internal.wrongCodeCount >= wrongCodeEntryLimit
  ) {
    internal.wrongCodeCount = 0;
    internal.lockoutEndsAt = Timestamp(
      Time.nowMs + Seconds(userCodeTemporaryDisableTime),
    );
    server.events.doorLockAlarm.emit(
      { alarmCode: DoorLock.AlarmCode.WrongCodeEntryLimit },
      server.context,
    );
  }
  throw new StatusResponseError(
    pin === undefined
      ? "PIN code required for remote operation"
      : "Invalid PIN code",
    StatusCode.Failure,
  );
}

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

class LockServerWithPinBase extends PinCredentialBase {
  declare state: LockServerWithPinBase.State;

  override async initialize() {
    applyPinDefaults(this.state);
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { lock: true });
    this.reactToCredentialChanges();
  }

  private reactToCredentialChanges() {
    const changed = credentialChangesOf(this.env);
    if (changed) {
      this.reactTo(changed, this.credentialsChanged, {
        offline: true,
        lock: true,
      });
    }
  }

  private credentialsChanged(entityId: string) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (entityId !== homeAssistant.entityId) {
      return;
    }
    applyPatchState(this.state, {
      requirePinForRemoteOperation: pinIsRequired(this.env, homeAssistant),
    });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    applyPatchState(this.state, pinLockState(this, entity));
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
    scheduleRelock(this);
  }

  override async unlockDoor(request: DoorLock.UnlockDoorRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.unlock(void 0, this.agent);

    const hasPinProvided = !!request.pinCode;
    logger.debug(
      `unlockDoor called for ${homeAssistant.entityId}, PIN provided: ${hasPinProvided}, requirePin: ${this.state.requirePinForRemoteOperation}`,
    );

    const pin = await assertRemotePin(this, request.pinCode, "unlockDoor");
    if (pin !== undefined) {
      action.data = { ...action.data, code: pin };
    }

    homeAssistant.callAction(action);
    scheduleRelock(this);
  }

  override async unlockWithTimeout(request: DoorLock.UnlockWithTimeoutRequest) {
    await this.unlockDoor(request);
    scheduleRelock(this, request.timeout);
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
      effectivePinCodeLengths(homeAssistant.state.mapping),
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

/** Plain lock/unlock without PIN, see LockServerBase. */
export function LockServer(config: LockServerConfig) {
  return LockServerBase.set({ config });
}

/** Unbolting without PIN, see LockServerWithUnboltBase. */
export function LockServerWithUnbolt(config: LockServerConfig) {
  return LockServerWithUnboltBase.set({ config });
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
 * (lock.unlock). Apple Home only sends unlock, so it always unlatches (#514).
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

class LockServerWithPinAndUnboltBase extends PinCredentialUnboltBase {
  declare state: LockServerWithPinAndUnboltBase.State;

  override async initialize() {
    applyPinDefaults(this.state);
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { lock: true });
    this.reactToCredentialChanges();
  }

  private reactToCredentialChanges() {
    const changed = credentialChangesOf(this.env);
    if (changed) {
      this.reactTo(changed, this.credentialsChanged, {
        offline: true,
        lock: true,
      });
    }
  }

  private credentialsChanged(entityId: string) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (entityId !== homeAssistant.entityId) {
      return;
    }
    applyPatchState(this.state, {
      requirePinForRemoteOperation: pinIsRequired(this.env, homeAssistant),
    });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    applyPatchState(this.state, pinLockState(this, entity));
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
    scheduleRelock(this);
  }

  override async unlockDoor(request: DoorLock.UnlockDoorRequest) {
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
    const pin = await assertRemotePin(this, request.pinCode, "unlockDoor");
    if (pin !== undefined) {
      action.data = { ...action.data, code: pin };
    }
    homeAssistant.callAction(action);
    scheduleRelock(this);
  }

  override async unlockWithTimeout(request: DoorLock.UnlockWithTimeoutRequest) {
    await this.unlockDoor(request);
    scheduleRelock(this, request.timeout);
  }

  override async unboltDoor(request: DoorLock.UnboltDoorRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    // Unbolt pulls the bolt but not the latch, so unlock, not open (#397).
    const action = this.state.config.unlock(void 0, this.agent);
    const hasPinProvided = !!request.pinCode;
    logger.debug(
      `unboltDoor called for ${homeAssistant.entityId}, PIN provided: ${hasPinProvided}, requirePin: ${this.state.requirePinForRemoteOperation}`,
    );
    const pin = await assertRemotePin(this, request.pinCode, "unboltDoor");
    if (pin !== undefined) {
      action.data = { ...action.data, code: pin };
    }
    homeAssistant.callAction(action);
    scheduleRelock(this);
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
      effectivePinCodeLengths(homeAssistant.state.mapping),
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
 */
export function LockServerWithPinAndUnbolt(config: LockServerConfig) {
  return LockServerWithPinAndUnboltBase.set({ config });
}
