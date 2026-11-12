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

  it("skips a bridge that is not a record object", async () => {
    const ctx = appStorage.createContext("entity-identities");
    await ctx.set("data", {
      version: 1,
      identities: { bridge1: null, bridge2: { k1: record } },
      // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    } as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    expect(storage.getBridgeIdentities("bridge1").size).toBe(0);
    expect(storage.getIdentity("bridge2", "k1")).toEqual(record);
  });

  it("skips records without a string endpointId", async () => {
    const ctx = appStorage.createContext("entity-identities");
    await ctx.set("data", {
      version: 1,
      identities: {
        bridge1: {
          k1: record,
          k2: { anchorEntityId: "light.other" },
          k3: { ...record, endpointId: 7 },
          k4: null,
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    } as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    expect(storage.getIdentity("bridge1", "k1")).toEqual(record);
    expect(storage.getIdentity("bridge1", "k2")).toBeUndefined();
    expect(storage.getIdentity("bridge1", "k3")).toBeUndefined();
    expect(storage.getIdentity("bridge1", "k4")).toBeUndefined();
  });

  it("leaves a file from a newer build alone", async () => {
    const ctx = appStorage.createContext("entity-identities");
    const newer = { version: 2, identities: { bridge1: { k1: record } } };
    // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    await ctx.set("data", newer as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    expect(storage.getIdentity("bridge1", "k1")).toEqual(record);
    await storage.dispose();

    expect(await ctx.get("data")).toEqual(newer);
  });

  it("never overwrites a file from a newer build when a record changes", async () => {
    const ctx = appStorage.createContext("entity-identities");
    const newer = {
      version: 2,
      identities: {
        b1: { k1: record, k2: { anchorEntityId: "light.other" } },
        b2: { k: record },
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    await ctx.set("data", newer as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    storage.setIdentity("b2", "k9", record);
    await storage.flush();
    expect(storage.getIdentity("b2", "k9")).toEqual(record);
    storage.markIdentityMissing("b1", "k1", "2026-07-01T00:00:00.000Z");
    storage.clearIdentityMissing("b1", "k1");
    await storage.deleteIdentity("b1", "k1");
    await storage.deleteBridgeIdentities("b2");
    await storage.dispose();

    expect(await ctx.get("data")).toEqual(newer);
  });

  it("writes unreadable entries back unchanged when a record changes", async () => {
    const ctx = appStorage.createContext("entity-identities");
    const unreadable = { anchorEntityId: "light.other" };
    await ctx.set("data", {
      version: 1,
      identities: { b1: { k1: record, k2: unreadable }, b2: null },
      // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    } as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    storage.setIdentity("b1", "k9", record);
    await storage.flush();

    expect(await ctx.get("data")).toEqual({
      version: 1,
      identities: { b1: { k1: record, k2: unreadable, k9: record }, b2: null },
    });
  });

  it("deletes a bridge's unreadable entries with the bridge", async () => {
    const ctx = appStorage.createContext("entity-identities");
    await ctx.set("data", {
      version: 1,
      identities: {
        b1: { k1: record, k2: { anchorEntityId: "light.other" } },
        b2: null,
        b3: { k1: record },
      },
      // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    } as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    await storage.deleteBridgeIdentities("b2");
    expect(await ctx.get("data")).toEqual({
      version: 1,
      identities: {
        b1: { k1: record, k2: { anchorEntityId: "light.other" } },
        b3: { k1: record },
      },
    });

    await storage.deleteBridgeIdentities("b1");
    storage.setIdentity("b1", "k9", record);
    await storage.flush();

    expect(await ctx.get("data")).toEqual({
      version: 1,
      identities: { b1: { k9: record }, b3: { k1: record } },
    });
  });

  it("drops the raw copy once a readable record takes its key", async () => {
    const ctx = appStorage.createContext("entity-identities");
    await ctx.set("data", {
      version: 1,
      identities: { b1: { k1: record, k2: { anchorEntityId: "light.other" } } },
      // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    } as any);

    const storage = new EntityIdentityStorage(appStorage);
    await storage.construction;
    storage.setIdentity("b1", "k2", record);
    await storage.flush();
    await storage.deleteIdentity("b1", "k2");

    expect(await ctx.get("data")).toEqual({
      version: 1,
      identities: { b1: { k1: record } },
    });
  });
});
