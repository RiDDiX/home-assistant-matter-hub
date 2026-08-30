import type { LockCredential } from "@home-assistant-matter-hub/common";
import { DoorLock } from "@matter/main/clusters";
import { beforeEach, describe, expect, it } from "vitest";
import type { LockCredentialStorage } from "../../services/storage/lock-credential-storage.js";
import {
  applyClearCredential,
  applySetCredential,
  applySetUser,
  buildGetCredentialStatusResponse,
  buildGetUserResponse,
  buildUsercodeClearAction,
  buildUsercodeSetAction,
  normalizeSupportedIndex,
} from "./lock-server.js";

type SetCredentialArgs = Parameters<LockCredentialStorage["setCredential"]>[0];
type SetUserArgs = Parameters<LockCredentialStorage["setUser"]>[0];

class FakeStorage {
  credentials = new Map<string, LockCredential>();

  hasCredential(entityId: string): boolean {
    const c = this.credentials.get(entityId);
    return !!c?.enabled && !!c.pinCodeHash;
  }

  hasUser(entityId: string): boolean {
    return this.credentials.has(entityId);
  }

  getCredential(entityId: string): LockCredential | undefined {
    return this.credentials.get(entityId);
  }

  async setCredential(request: SetCredentialArgs): Promise<LockCredential> {
    const now = 1;
    const existing = this.credentials.get(request.entityId);
    const credential: LockCredential = {
      entityId: request.entityId,
      pinCodeHash: `hash:${request.pinCode}`,
      pinCodeSalt: "salt",
      name: request.name ?? existing?.name,
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
    return credential;
  }

  async deleteCredential(entityId: string): Promise<void> {
    this.credentials.delete(entityId);
  }

  async setUser(params: SetUserArgs): Promise<LockCredential> {
    const now = 1;
    const existing = this.credentials.get(params.entityId);
    const credential: LockCredential = {
      entityId: params.entityId,
      pinCodeHash: existing?.pinCodeHash ?? "",
      pinCodeSalt: existing?.pinCodeSalt ?? "",
      name: existing?.name,
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
    return credential;
  }
}

function makeEnv(storage: FakeStorage) {
  return {
    get: () => storage as unknown as LockCredentialStorage,
  };
}

const ENTITY = "lock.front_door";
const PIN_LENGTHS = { min: 4, max: 8 };

describe("normalizeSupportedIndex", () => {
  it("maps 0 (allocate any free slot) to the single supported slot", () => {
    expect(normalizeSupportedIndex(0)).toBe(1);
  });

  it("accepts the single supported slot 1", () => {
    expect(normalizeSupportedIndex(1)).toBe(1);
  });

  it("rejects other indexes", () => {
    expect(normalizeSupportedIndex(2)).toBeNull();
    expect(normalizeSupportedIndex(-1)).toBeNull();
    expect(normalizeSupportedIndex(null)).toBeNull();
    expect(normalizeSupportedIndex(undefined)).toBeNull();
  });
});

describe("applySetCredential", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  it("stores a PIN when credentialIndex is 0 and points at slot 1", async () => {
    const response = await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 0,
        },
        credentialData: new TextEncoder().encode("1234"),
        userIndex: 1,
        userStatus: null,
        userType: null,
      },
      3,
      PIN_LENGTHS,
    );

    expect(response.status).toBe(0x00);
    expect(response.userIndex).toBe(1);
    expect(storage.hasCredential(ENTITY)).toBe(true);
    const stored = storage.getCredential(ENTITY);
    expect(stored?.creatorFabricIndex).toBe(3);
    expect(stored?.lastModifiedFabricIndex).toBe(3);
  });

  // A zero length Uint8Array is truthy, so the empty PIN used to be stored and
  // then satisfied the very PIN check it switched on.
  it("rejects an empty PIN", async () => {
    const response = await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
        credentialData: new Uint8Array(0),
        userIndex: 1,
        userStatus: null,
        userType: null,
      },
      3,
      PIN_LENGTHS,
    );

    expect(response.status).not.toBe(0x00);
    expect(storage.hasCredential(ENTITY)).toBe(false);
  });

  it("rejects a PIN longer than the advertised maximum", async () => {
    const response = await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
        credentialData: new TextEncoder().encode("123456789"),
        userIndex: 1,
        userStatus: null,
        userType: null,
      },
      3,
      PIN_LENGTHS,
    );

    expect(response.status).not.toBe(0x00);
    expect(storage.hasCredential(ENTITY)).toBe(false);
  });

  it("also accepts credentialIndex 1", async () => {
    const response = await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
        credentialData: new TextEncoder().encode("1234"),
        userIndex: 1,
        userStatus: null,
        userType: null,
      },
      undefined,
      PIN_LENGTHS,
    );
    expect(response.status).toBe(0x00);
    expect(response.userIndex).toBe(1);
  });

  it("rejects credentialIndex outside the supported range", async () => {
    const response = await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 2,
        },
        credentialData: new TextEncoder().encode("1234"),
        userIndex: 1,
        userStatus: null,
        userType: null,
      },
      undefined,
      PIN_LENGTHS,
    );
    expect(response.status).toBe(0x01);
    expect(response.userIndex).toBeNull();
    expect(storage.hasCredential(ENTITY)).toBe(false);
  });

  it("rejects non-PIN credential types", async () => {
    const response = await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Rfid,
          credentialIndex: 1,
        },
        credentialData: new TextEncoder().encode("1234"),
        userIndex: 1,
        userStatus: null,
        userType: null,
      },
      undefined,
      PIN_LENGTHS,
    );
    expect(response.status).toBe(0x01);
  });

  it("rejects an unsupported userIndex", async () => {
    const response = await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
        credentialData: new TextEncoder().encode("1234"),
        userIndex: 5,
        userStatus: null,
        userType: null,
      },
      undefined,
      PIN_LENGTHS,
    );
    expect(response.status).toBe(0x01);
  });
});

describe("applySetUser", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  it("marks slot 1 as occupied even before a PIN is set", async () => {
    await applySetUser(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        userIndex: 1,
        userName: "Apple Home",
        userUniqueId: 42,
        userStatus: null,
        userType: null,
        credentialRule: null,
      },
      7,
    );

    expect(storage.hasUser(ENTITY)).toBe(true);
    const response = buildGetUserResponse(makeEnv(storage), ENTITY, 1);
    expect(response.userStatus).toBe(DoorLock.UserStatus.OccupiedEnabled);
    expect(response.userName).toBe("Apple Home");
    expect(response.userUniqueId).toBe(42);
    expect(response.creatorFabricIndex).toBe(7);
    expect(response.lastModifiedFabricIndex).toBe(7);
    // No PIN was stored yet, so the user has no associated credentials.
    expect(response.credentials).toEqual([]);
  });

  it("throws for invalid user indexes", async () => {
    await expect(
      applySetUser(
        makeEnv(storage),
        ENTITY,
        {
          operationType: DoorLock.DataOperationType.Add,
          userIndex: 7,
          userName: null,
          userUniqueId: null,
          userStatus: null,
          userType: null,
          credentialRule: null,
        },
        undefined,
      ),
    ).rejects.toThrow();
  });
});

describe("buildGetUserResponse", () => {
  it("returns Available with null fabric metadata when nothing is stored", () => {
    const storage = new FakeStorage();
    const response = buildGetUserResponse(makeEnv(storage), ENTITY, 1);
    expect(response.userStatus).toBe(DoorLock.UserStatus.Available);
    expect(response.credentials).toBeNull();
    expect(response.creatorFabricIndex).toBeNull();
    expect(response.lastModifiedFabricIndex).toBeNull();
  });

  it("reflects stored credential and fabric metadata for slot 1", async () => {
    const storage = new FakeStorage();
    await storage.setCredential({
      entityId: ENTITY,
      pinCode: "1234",
      enabled: true,
      creatorFabricIndex: 2,
      lastModifiedFabricIndex: 2,
    });
    const response = buildGetUserResponse(makeEnv(storage), ENTITY, 1);
    expect(response.userIndex).toBe(1);
    expect(response.userStatus).toBe(DoorLock.UserStatus.OccupiedEnabled);
    expect(response.credentials).toEqual([
      { credentialType: DoorLock.CredentialType.Pin, credentialIndex: 1 },
    ]);
    expect(response.creatorFabricIndex).toBe(2);
    expect(response.lastModifiedFabricIndex).toBe(2);
  });
});

describe("buildGetCredentialStatusResponse", () => {
  it("reports credentialExists=false for unknown slots", () => {
    const storage = new FakeStorage();
    const response = buildGetCredentialStatusResponse(
      makeEnv(storage),
      ENTITY,
      {
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
      },
    );
    expect(response.credentialExists).toBe(false);
    expect(response.userIndex).toBeNull();
  });

  it("reports credentialExists=true and fabric metadata when a PIN is stored", async () => {
    const storage = new FakeStorage();
    await storage.setCredential({
      entityId: ENTITY,
      pinCode: "1234",
      enabled: true,
      creatorFabricIndex: 4,
      lastModifiedFabricIndex: 4,
    });
    const response = buildGetCredentialStatusResponse(
      makeEnv(storage),
      ENTITY,
      {
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
      },
    );
    expect(response.credentialExists).toBe(true);
    expect(response.userIndex).toBe(1);
    expect(response.creatorFabricIndex).toBe(4);
    expect(response.lastModifiedFabricIndex).toBe(4);
  });

  it("rejects credentialIndex outside the supported range", () => {
    const storage = new FakeStorage();
    const response = buildGetCredentialStatusResponse(
      makeEnv(storage),
      ENTITY,
      {
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 9,
        },
      },
    );
    expect(response.credentialExists).toBe(false);
  });
});

describe("Apple Home setup flow parity", () => {
  // Apple Home for SwitchBot Lock Ultra calls:
  //   SetUser(Add, userIndex=1) then SetCredential(Add, credentialIndex=0).
  // After this slot 1 must look occupied and no longer trigger the
  // "set up access code" prompt.
  it("ends with an occupied slot when SetUser is followed by SetCredential", async () => {
    const storage = new FakeStorage();
    const env = makeEnv(storage);

    await applySetUser(
      env,
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        userIndex: 1,
        userName: "iOS",
        userUniqueId: 11,
        userStatus: null,
        userType: null,
        credentialRule: null,
      },
      5,
    );

    const setCredentialResponse = await applySetCredential(
      env,
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 0,
        },
        credentialData: new TextEncoder().encode("2468"),
        userIndex: 1,
        userStatus: null,
        userType: null,
      },
      5,
      PIN_LENGTHS,
    );

    expect(setCredentialResponse.status).toBe(0x00);
    expect(setCredentialResponse.userIndex).toBe(1);

    const userResponse = buildGetUserResponse(env, ENTITY, 1);
    expect(userResponse.userStatus).toBe(DoorLock.UserStatus.OccupiedEnabled);
    expect(userResponse.userName).toBe("iOS");
    expect(userResponse.creatorFabricIndex).toBe(5);

    const credentialResponse = buildGetCredentialStatusResponse(env, ENTITY, {
      credential: {
        credentialType: DoorLock.CredentialType.Pin,
        credentialIndex: 1,
      },
    });
    expect(credentialResponse.credentialExists).toBe(true);
    expect(credentialResponse.userIndex).toBe(1);
    expect(credentialResponse.creatorFabricIndex).toBe(5);
    expect(credentialResponse.lastModifiedFabricIndex).toBe(5);
  });
});

describe("applyClearCredential", () => {
  let storage: FakeStorage;

  beforeEach(async () => {
    storage = new FakeStorage();
    await storage.setCredential({
      entityId: ENTITY,
      pinCode: "1234",
      enabled: true,
      creatorFabricIndex: 1,
      lastModifiedFabricIndex: 1,
    });
  });

  it("clears the PIN when credential is null (clear-all)", async () => {
    await applyClearCredential(makeEnv(storage), ENTITY, { credential: null });
    expect(storage.hasCredential(ENTITY)).toBe(false);
  });

  it("clears the PIN for a supported credentialIndex (1)", async () => {
    await applyClearCredential(makeEnv(storage), ENTITY, {
      credential: {
        credentialType: DoorLock.CredentialType.Pin,
        credentialIndex: 1,
      },
    });
    expect(storage.hasCredential(ENTITY)).toBe(false);
  });

  it("does NOT delete when credentialIndex is unsupported", async () => {
    await applyClearCredential(makeEnv(storage), ENTITY, {
      credential: {
        credentialType: DoorLock.CredentialType.Pin,
        credentialIndex: 9,
      },
    });
    expect(storage.hasCredential(ENTITY)).toBe(true);
  });

  it("does NOT delete for a non-PIN credential type", async () => {
    await applyClearCredential(makeEnv(storage), ENTITY, {
      credential: {
        credentialType: DoorLock.CredentialType.Rfid,
        credentialIndex: 1,
      },
    });
    expect(storage.hasCredential(ENTITY)).toBe(true);
  });
});

describe("usercode passthrough builders (#418)", () => {
  it("zwave_js set uses the usercode key", () => {
    expect(
      buildUsercodeSetAction("zwave_js.set_lock_usercode", 3, "4321"),
    ).toEqual({
      action: "zwave_js.set_lock_usercode",
      data: { code_slot: 3, usercode: "4321" },
    });
  });

  it("zha set uses the user_code key", () => {
    expect(buildUsercodeSetAction("zha.set_lock_user_code", 2, "1111")).toEqual(
      {
        action: "zha.set_lock_user_code",
        data: { code_slot: 2, user_code: "1111" },
      },
    );
  });

  it("zwave_js clear derives from the set service", () => {
    expect(buildUsercodeClearAction("zwave_js.set_lock_usercode", 3)).toEqual({
      action: "zwave_js.clear_lock_usercode",
      data: { code_slot: 3 },
    });
  });

  it("zha clear derives from the set service", () => {
    expect(buildUsercodeClearAction("zha.set_lock_user_code", 2)).toEqual({
      action: "zha.clear_lock_user_code",
      data: { code_slot: 2 },
    });
  });
});

describe("SetCredential ownership rules", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  async function add(fabric: number, pin = "1234") {
    return applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
        credentialData: new TextEncoder().encode(pin),
        userIndex: 1,
        userStatus: null,
        userType: null,
      } as never,
      fabric,
      PIN_LENGTHS,
    );
  }

  async function modify(fabric: number, pin = "5678") {
    return applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Modify,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
        credentialData: new TextEncoder().encode(pin),
        userIndex: 1,
        userStatus: null,
        userType: null,
      } as never,
      fabric,
      PIN_LENGTHS,
    );
  }

  it("refuses to Add over an occupied slot", async () => {
    expect((await add(3)).status).toBe(0x00);
    expect((await add(3)).status).not.toBe(0x00);
    expect(storage.getCredential(ENTITY)?.pinCodeHash).toBe("hash:1234");
  });

  it("refuses to Modify a slot that has no PIN", async () => {
    expect((await modify(3)).status).not.toBe(0x00);
  });

  it("refuses a Modify from another fabric", async () => {
    await add(3);
    expect((await modify(4)).status).not.toBe(0x00);
    expect(storage.getCredential(ENTITY)?.pinCodeHash).toBe("hash:1234");
  });

  it("lets the creating fabric Modify", async () => {
    await add(3);
    expect((await modify(3)).status).toBe(0x00);
    expect(storage.getCredential(ENTITY)?.pinCodeHash).toBe("hash:5678");
  });

  it("still allows Add after SetUser reserved the slot without a PIN", async () => {
    await applySetUser(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        userIndex: 1,
        userName: "Front",
        userUniqueId: 1,
        userStatus: null,
        userType: null,
        credentialRule: null,
      } as never,
      3,
    );
    expect((await add(3)).status).toBe(0x00);
  });
});

describe("SetUser ownership rules", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  function request(op: "Add" | "Modify", userName: string | null) {
    return {
      operationType: DoorLock.DataOperationType[op],
      userIndex: 1,
      userName,
      userUniqueId: null,
      userStatus: null,
      userType: null,
      credentialRule: null,
    } as never;
  }

  it("refuses to Add over an occupied user slot", async () => {
    await applySetUser(makeEnv(storage), ENTITY, request("Add", "Front"), 3);
    await expect(
      applySetUser(makeEnv(storage), ENTITY, request("Add", "Other"), 3),
    ).rejects.toThrow();
  });

  it("refuses to Modify a user slot that does not exist", async () => {
    await expect(
      applySetUser(makeEnv(storage), ENTITY, request("Modify", "Front"), 3),
    ).rejects.toThrow();
  });

  it("refuses a rename from another fabric", async () => {
    await applySetUser(makeEnv(storage), ENTITY, request("Add", "Front"), 3);
    await expect(
      applySetUser(makeEnv(storage), ENTITY, request("Modify", "Theirs"), 4),
    ).rejects.toThrow();
    expect(storage.getCredential(ENTITY)?.userName).toBe("Front");
  });
});

describe("physical programming failures", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  const failing = {
    service: "zha.set_lock_user_code",
    slot: 1,
    program: async () => {
      throw new Error("lock said no");
    },
  };

  it("does not store a PIN the lock refused", async () => {
    const response = await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
        credentialData: new TextEncoder().encode("1234"),
        userIndex: 1,
        userStatus: null,
        userType: null,
      } as never,
      3,
      PIN_LENGTHS,
      failing,
    );

    expect(response.status).not.toBe(0x00);
    expect(storage.hasCredential(ENTITY)).toBe(false);
  });

  it("keeps the PIN when the lock could not clear it", async () => {
    await applySetCredential(
      makeEnv(storage),
      ENTITY,
      {
        operationType: DoorLock.DataOperationType.Add,
        credential: {
          credentialType: DoorLock.CredentialType.Pin,
          credentialIndex: 1,
        },
        credentialData: new TextEncoder().encode("1234"),
        userIndex: 1,
        userStatus: null,
        userType: null,
      } as never,
      3,
      PIN_LENGTHS,
    );

    await expect(
      applyClearCredential(
        makeEnv(storage),
        ENTITY,
        { credential: null } as never,
        failing,
      ),
    ).rejects.toThrow();
    expect(storage.hasCredential(ENTITY)).toBe(true);
  });
});
