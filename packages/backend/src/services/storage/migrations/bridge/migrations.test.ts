import { StorageBackendMemory, StorageContext } from "@matter/general";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateBridgeV1ToV2 } from "./v1-to-v2.js";
import { migrateBridgeV2ToV3 } from "./v2-to-v3.js";
import { migrateBridgeV3ToV4 } from "./v3-to-v4.js";
import { migrateBridgeV4ToV5 } from "./v4-to-v5.js";

function freshContext(): StorageContext {
  const backend = new StorageBackendMemory();
  backend.initialize();
  return new StorageContext(backend, ["bridges"]);
}

async function readBridge(
  storage: StorageContext,
  id: string,
): Promise<Record<string, unknown>> {
  return (await storage.get(id)) as unknown as Record<string, unknown>;
}

async function readFlags(
  storage: StorageContext,
  id: string,
): Promise<Record<string, unknown>> {
  const bridge = await readBridge(storage, id);
  return bridge.featureFlags as Record<string, unknown>;
}

describe("migrateBridgeV1ToV2", () => {
  let storage: StorageContext;
  beforeEach(() => {
    storage = freshContext();
  });

  it("bumps the version and clears the compatibility field", async () => {
    await storage.set("ids", JSON.stringify(["b1"]));
    await storage.set(
      "b1",
      JSON.stringify({ id: "b1", compatibility: "old", name: "living" }),
    );

    const next = await migrateBridgeV1ToV2(storage);
    expect(next).toBe(2);

    const ids = (await storage.get("ids")) as unknown as string[];
    expect(ids).toEqual(["b1"]);
    const bridge = await readBridge(storage, "b1");
    expect(bridge.compatibility).toBeUndefined();
    expect(bridge.name).toBe("living");
  });

  it("defaults ids to an empty array when not set", async () => {
    await expect(migrateBridgeV1ToV2(storage)).resolves.toBe(2);
    const ids = (await storage.get("ids", "[]")) as unknown as string[];
    const resolved = typeof ids === "string" ? JSON.parse(ids) : ids;
    expect(resolved).toEqual([]);
  });
});

describe("migrateBridgeV2ToV3", () => {
  let storage: StorageContext;
  beforeEach(() => {
    storage = freshContext();
  });

  it("parses stringified ids and bridges", async () => {
    await storage.set("ids", JSON.stringify(["b1"]));
    await storage.set("b1", JSON.stringify({ id: "b1", name: "bath" }));

    const next = await migrateBridgeV2ToV3(storage);
    expect(next).toBe(3);
    const ids = (await storage.get("ids")) as unknown as string[];
    expect(ids).toEqual(["b1"]);
    const bridge = await readBridge(storage, "b1");
    expect(bridge.name).toBe("bath");
  });

  it("leaves already-parsed values untouched", async () => {
    await storage.set("ids", ["b1"]);
    await storage.set("b1", { id: "b1", name: "den" } as unknown as Record<
      string,
      string
    >);

    const next = await migrateBridgeV2ToV3(storage);
    expect(next).toBe(3);
    const bridge = await readBridge(storage, "b1");
    expect(bridge.name).toBe("den");
  });
});

describe("migrateBridgeV3ToV4", () => {
  let storage: StorageContext;
  beforeEach(() => {
    storage = freshContext();
  });

  it("renames mimicHaCoverPercentage into the two new flags", async () => {
    await storage.set("ids", ["b1"]);
    await storage.set("b1", {
      id: "b1",
      featureFlags: { mimicHaCoverPercentage: true, otherFlag: true },
    } as unknown as Record<string, string>);

    const next = await migrateBridgeV3ToV4(storage);
    expect(next).toBe(4);
    const flags = await readFlags(storage, "b1");
    expect(flags.coverDoNotInvertPercentage).toBe(true);
    expect(flags.coverSwapOpenClose).toBe(true);
    expect(flags.mimicHaCoverPercentage).toBeUndefined();
    expect(flags.otherFlag).toBe(true);
  });

  it("defaults the two new flags to false when the legacy flag is absent", async () => {
    await storage.set("ids", ["b1"]);
    await storage.set("b1", { id: "b1", featureFlags: {} } as unknown as Record<
      string,
      string
    >);

    await migrateBridgeV3ToV4(storage);
    const flags = await readFlags(storage, "b1");
    expect(flags.coverDoNotInvertPercentage).toBe(false);
    expect(flags.coverSwapOpenClose).toBe(false);
  });

  it("skips bridges without featureFlags", async () => {
    await storage.set("ids", ["b1"]);
    await storage.set("b1", { id: "b1" } as unknown as Record<string, string>);

    await expect(migrateBridgeV3ToV4(storage)).resolves.toBe(4);
  });
});

describe("migrateBridgeV4ToV5", () => {
  let storage: StorageContext;
  beforeEach(() => {
    storage = freshContext();
  });

  it("drops the four removed feature flags", async () => {
    await storage.set("ids", ["b1"]);
    await storage.set("b1", {
      id: "b1",
      featureFlags: {
        coverSwapOpenClose: true,
        matterFans: true,
        matterSpeakers: true,
        useOnOffSensorAsDefaultForBinarySensors: true,
        keepMe: true,
      },
    } as unknown as Record<string, string>);

    const next = await migrateBridgeV4ToV5(storage);
    expect(next).toBe(5);
    const flags = await readFlags(storage, "b1");
    expect(flags.coverSwapOpenClose).toBeUndefined();
    expect(flags.matterFans).toBeUndefined();
    expect(flags.matterSpeakers).toBeUndefined();
    expect(flags.useOnOffSensorAsDefaultForBinarySensors).toBeUndefined();
    expect(flags.keepMe).toBe(true);
  });

  it("skips bridges without featureFlags", async () => {
    await storage.set("ids", ["b1"]);
    await storage.set("b1", { id: "b1" } as unknown as Record<string, string>);

    await expect(migrateBridgeV4ToV5(storage)).resolves.toBe(5);
  });
});

describe("migration chain", () => {
  it("carries a v1 bridge through the full v1 → v5 path", async () => {
    const storage = freshContext();
    await storage.set("ids", JSON.stringify(["b1"]));
    await storage.set(
      "b1",
      JSON.stringify({
        id: "b1",
        compatibility: "legacy",
        featureFlags: {
          mimicHaCoverPercentage: true,
          matterFans: true,
        },
      }),
    );

    expect(await migrateBridgeV1ToV2(storage)).toBe(2);
    expect(await migrateBridgeV2ToV3(storage)).toBe(3);
    expect(await migrateBridgeV3ToV4(storage)).toBe(4);
    expect(await migrateBridgeV4ToV5(storage)).toBe(5);

    const bridge = await readBridge(storage, "b1");
    expect(bridge.compatibility).toBeUndefined();
    const flags = bridge.featureFlags as Record<string, unknown>;
    expect(flags.coverDoNotInvertPercentage).toBe(true);
    expect(flags.coverSwapOpenClose).toBeUndefined();
    expect(flags.mimicHaCoverPercentage).toBeUndefined();
    expect(flags.matterFans).toBeUndefined();
  });
});
