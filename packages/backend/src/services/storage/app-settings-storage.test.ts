import { describe, expect, it } from "vitest";
import { AppSettingsStorage } from "./app-settings-storage.js";
import type { AppStorage } from "./app-storage.js";

async function createStorage() {
  const data = new Map<string, unknown>();
  const appStorage = {
    createContext: () => ({
      get: async (key: string, fallback: unknown) => data.get(key) ?? fallback,
      set: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
    }),
  } as unknown as AppStorage;
  const storage = new AppSettingsStorage(appStorage);
  await storage.construction;
  return { storage, appStorage };
}

describe("AppSettingsStorage auth", () => {
  it("verifies the stored hash without the cache", async () => {
    const { storage, appStorage } = await createStorage();
    await storage.setAuth({ username: "admin", password: "secret" });

    // A fresh instance has no cached plaintext and must run scrypt.
    const fresh = new AppSettingsStorage(appStorage);
    await fresh.construction;
    expect(await fresh.verifyAuth("admin", "wrong")).toBe(false);
    expect(await fresh.verifyAuth("other", "secret")).toBe(false);
    expect(await fresh.verifyAuth("admin", "secret")).toBe(true);
  });

  it("rejects a password checked against replaced credentials", async () => {
    const { storage, appStorage } = await createStorage();
    await storage.setAuth({ username: "admin", password: "old" });
    const fresh = new AppSettingsStorage(appStorage);
    await fresh.construction;

    const pending = fresh.verifyAuth("admin", "old");
    await fresh.setAuth({ username: "admin", password: "new" });
    expect(await pending).toBe(false);
  });
});
