import { describe, expect, it } from "vitest";
import type { AppStorage } from "./app-storage.js";
import { LockCredentialStorage } from "./lock-credential-storage.js";

// A file version this build does not know used to send load() into the v1
// migration, which ignored it, so nothing loaded and the next write persisted
// an empty set over the PINs.
function storageWith(data: unknown) {
  const written: unknown[] = [];
  const appStorage = {
    createContext: () => ({
      get: async () => data,
      set: async (_key: string, value: unknown) => {
        written.push(value);
      },
    }),
  } as unknown as AppStorage;
  return { appStorage, written };
}

async function load(data: unknown) {
  const { appStorage, written } = storageWith(data);
  const storage = new LockCredentialStorage(appStorage);
  await storage.construction;
  return { storage, written };
}

const hashed = {
  entityId: "lock.front",
  pinCodeHash: "aa",
  pinCodeSalt: "bb",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

describe("LockCredentialStorage.load", () => {
  it("keeps readable records from a newer file version", async () => {
    const { storage } = await load({ version: 99, credentials: [hashed] });
    expect(storage.getCredential("lock.front")).toBeDefined();
  });

  it("survives a half migrated v1 file", async () => {
    const { storage } = await load({
      version: 1,
      credentials: [
        hashed,
        { entityId: "lock.side", pinCode: "1234", enabled: true },
        { entityId: "lock.broken", enabled: true },
      ],
    });
    expect(storage.getCredential("lock.front")).toBeDefined();
    expect(storage.getCredential("lock.side")?.pinCodeHash).toBeTruthy();
    expect(storage.getCredential("lock.broken")).toBeUndefined();
  });

  it("ignores a file without a credential list", async () => {
    const { storage } = await load({ version: 2, credentials: null });
    expect(storage.getAllCredentials()).toEqual([]);
  });
});

describe("LockCredentialStorage.changed", () => {
  it("announces the entity whose credential moved", async () => {
    const { storage } = await load({ version: 2, credentials: [] });
    const seen: string[] = [];
    storage.changed.on((entityId) => {
      seen.push(entityId);
    });

    await storage.setCredential({ entityId: "lock.front", pinCode: "1234" });
    await storage.deleteCredential("lock.front");

    expect(seen).toEqual(["lock.front", "lock.front"]);
  });
});
