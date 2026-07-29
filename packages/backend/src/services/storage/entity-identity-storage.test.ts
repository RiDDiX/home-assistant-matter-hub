import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { StorageService } from "@matter/main";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStorage } from "./app-storage.js";
import {
  EntityIdentityStorage,
  type IdentityRecord,
} from "./entity-identity-storage.js";

let dir: string;
let env: Environment;
let appStorage: AppStorage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hamh-identity-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  appStorage = new AppStorage(env.get(StorageService));
  await appStorage.construction;
});

afterEach(async () => {
  await appStorage.dispose().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const record: IdentityRecord = {
  endpointId: "light_kitchen",
  anchorEntityId: "light.kitchen",
  lastEntityId: "light.kitchen",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("EntityIdentityStorage", () => {
  it("round-trips records through a flushed reload (#404)", async () => {
    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;

    const key = "hue light abc";
    storage.setIdentity("bridge1", key, record);
    await storage.flush();

    const reloaded = new EntityIdentityStorage(appStorage);
    await reloaded.construction;
    expect(reloaded.getIdentity("bridge1", key)).toEqual(record);
  });

  it("keeps records scoped per bridge and deletes only the asked bridge", async () => {
    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;

    storage.setIdentity("bridge1", "k1", record);
    storage.setIdentity("bridge2", "k2", {
      ...record,
      anchorEntityId: "light.other",
    });
    await storage.flush();

    await storage.deleteBridgeIdentities("bridge1");

    expect(storage.getIdentity("bridge1", "k1")).toBeUndefined();
    expect(storage.getIdentity("bridge2", "k2")).toBeDefined();

    const reloaded = new EntityIdentityStorage(appStorage);
    await reloaded.construction;
    expect(reloaded.getIdentity("bridge1", "k1")).toBeUndefined();
    expect(reloaded.getIdentity("bridge2", "k2")).toBeDefined();
  });

  it("deleteIdentity removes exactly one key and leaves the rest (orphan cleanup)", async () => {
    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;

    storage.setIdentity("bridge1", "k1", record);
    storage.setIdentity("bridge1", "k2", {
      ...record,
      anchorEntityId: "light.other",
    });
    await storage.flush();

    await storage.deleteIdentity("bridge1", "k1");
    expect(storage.getIdentity("bridge1", "k1")).toBeUndefined();
    expect(storage.getIdentity("bridge1", "k2")).toBeDefined();

    const reloaded = new EntityIdentityStorage(appStorage);
    await reloaded.construction;
    expect(reloaded.getIdentity("bridge1", "k1")).toBeUndefined();
    expect(reloaded.getIdentity("bridge1", "k2")).toBeDefined();
  });

  it("missingSince round-trips through a flushed reload", async () => {
    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;

    storage.setIdentity("bridge1", "k1", record);
    storage.markIdentityMissing("bridge1", "k1", "2026-07-01T00:00:00.000Z");
    await storage.flush();

    const reloaded = new EntityIdentityStorage(appStorage);
    await reloaded.construction;
    expect(reloaded.getIdentity("bridge1", "k1")?.missingSince).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("markIdentityMissing keeps the first-seen time, clearIdentityMissing drops it", async () => {
    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;

    storage.setIdentity("bridge1", "k1", record);
    storage.markIdentityMissing("bridge1", "k1", "2026-07-01T00:00:00.000Z");
    // a later pass must not overwrite the first-seen time
    storage.markIdentityMissing("bridge1", "k1", "2026-07-05T00:00:00.000Z");
    expect(storage.getIdentity("bridge1", "k1")?.missingSince).toBe(
      "2026-07-01T00:00:00.000Z",
    );

    storage.clearIdentityMissing("bridge1", "k1");
    expect(storage.getIdentity("bridge1", "k1")?.missingSince).toBeUndefined();
  });

  it("loads an old record that predates the missingSince field", async () => {
    const ctx = appStorage.createContext("entity-identities");
    const legacy = {
      endpointId: "light_kitchen",
      anchorEntityId: "light.kitchen",
      lastEntityId: "light.kitchen",
    };
    await ctx.set("data", {
      version: 1,
      identities: { bridge1: { k1: legacy } },
      // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    } as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    const loaded = storage.getIdentity("bridge1", "k1");
    expect(loaded).toEqual(legacy);
    expect(loaded?.missingSince).toBeUndefined();
  });

  it("passes an older stored version through the self-migrate", async () => {
    // Seed the raw context as if written by a previous version.
    const ctx = appStorage.createContext("entity-identities");
    await ctx.set("data", {
      version: 0,
      identities: { bridge1: { "hue light abc": record } },
      // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    } as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    expect(storage.getIdentity("bridge1", "hue light abc")).toEqual(record);

    // Migration should have re-persisted at the current version, so a fresh
    // instance loads the same record without another migrate.
    const reloaded = new EntityIdentityStorage(appStorage);
    await reloaded.construction;
    expect(reloaded.getIdentity("bridge1", "hue light abc")).toEqual(record);
  });
});
