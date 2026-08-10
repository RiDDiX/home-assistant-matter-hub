import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { StorageService } from "@matter/main";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStorage } from "./app-storage.js";
import { EntityMappingStorage } from "./entity-mapping-storage.js";

let dir: string;
let env: Environment;
let appStorage: AppStorage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hamh-mapping-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  appStorage = new AppStorage(env.get(StorageService));
  await appStorage.construction;
});

afterEach(async () => {
  await appStorage.dispose().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

function missingSince(m: unknown): string | undefined {
  return (m as { missingSince?: string } | undefined)?.missingSince;
}

describe("EntityMappingStorage orphan tombstone", () => {
  it("marks once keeping first-seen, and round-trips missingSince through a flushed reload", async () => {
    const storage = new EntityMappingStorage(appStorage);
    await storage.construction;
    await storage.setMapping({
      bridgeId: "b",
      entityId: "light.x",
      customName: "Lamp",
    });

    storage.markMappingMissing("b", "light.x", "2026-07-01T00:00:00.000Z");
    // a later pass must not overwrite the first-seen time
    storage.markMappingMissing("b", "light.x", "2026-07-05T00:00:00.000Z");
    await storage.flush();

    const reloaded = new EntityMappingStorage(appStorage);
    await reloaded.construction;
    expect(missingSince(reloaded.getMapping("b", "light.x"))).toBe(
      "2026-07-01T00:00:00.000Z",
    );

    reloaded.clearMappingMissing("b", "light.x");
    expect(missingSince(reloaded.getMapping("b", "light.x"))).toBeUndefined();
  });

  it("no-ops mark/clear when there is no such mapping", async () => {
    const storage = new EntityMappingStorage(appStorage);
    await storage.construction;
    // must not throw and must not conjure a record
    storage.markMappingMissing("b", "nope", "2026-07-01T00:00:00.000Z");
    storage.clearMappingMissing("b", "nope");
    expect(storage.getMapping("b", "nope")).toBeUndefined();
  });

  it("persists a mapping holding only vacuumRoomSwitches and round-trips it", async () => {
    const storage = new EntityMappingStorage(appStorage);
    await storage.construction;
    await storage.setMapping({
      bridgeId: "b",
      entityId: "vacuum.robot",
      vacuumRoomSwitches: true,
    });
    expect(storage.getMapping("b", "vacuum.robot")?.vacuumRoomSwitches).toBe(
      true,
    );

    await storage.flush();
    const reloaded = new EntityMappingStorage(appStorage);
    await reloaded.construction;
    expect(reloaded.getMapping("b", "vacuum.robot")?.vacuumRoomSwitches).toBe(
      true,
    );
  });

  it("keeps vacuumRoomSwitches when saved alongside another field", async () => {
    const storage = new EntityMappingStorage(appStorage);
    await storage.construction;
    await storage.setMapping({
      bridgeId: "b",
      entityId: "vacuum.robot",
      customName: "Robo",
      vacuumRoomSwitches: true,
    });
    const loaded = storage.getMapping("b", "vacuum.robot");
    expect(loaded?.customName).toBe("Robo");
    expect(loaded?.vacuumRoomSwitches).toBe(true);
  });

  // #443: the new per-entity fan debounce field must survive the storage
  // normalizer and a flushed reload like every other mapping field.
  it("persists fanSliderDebounceMs and round-trips it through a reload", async () => {
    const storage = new EntityMappingStorage(appStorage);
    await storage.construction;
    await storage.setMapping({
      bridgeId: "b",
      entityId: "fan.f",
      fanSliderDebounceMs: 1200,
    });
    expect(storage.getMapping("b", "fan.f")?.fanSliderDebounceMs).toBe(1200);

    await storage.flush();
    const reloaded = new EntityMappingStorage(appStorage);
    await reloaded.construction;
    expect(reloaded.getMapping("b", "fan.f")?.fanSliderDebounceMs).toBe(1200);
  });

  it("caps fanSliderDebounceMs and drops non-positive values", async () => {
    const storage = new EntityMappingStorage(appStorage);
    await storage.construction;
    await storage.setMapping({
      bridgeId: "b",
      entityId: "fan.f",
      fanSliderDebounceMs: 9999,
    });
    expect(storage.getMapping("b", "fan.f")?.fanSliderDebounceMs).toBe(5000);

    // A lone invalid value leaves nothing worth storing.
    await storage.setMapping({
      bridgeId: "b",
      entityId: "fan.f",
      fanSliderDebounceMs: -5,
    });
    expect(storage.getMapping("b", "fan.f")).toBeUndefined();
  });

  it("loads an old mapping that predates the missingSince field", async () => {
    const ctx = appStorage.createContext("entity-mappings");
    await ctx.set("data", {
      version: 1,
      mappings: { b: [{ entityId: "light.legacy", customName: "Old" }] },
      // biome-ignore lint/suspicious/noExplicitAny: raw stored shape
    } as any);

    const storage = new EntityMappingStorage(appStorage);
    await storage.construction;
    const loaded = storage.getMapping("b", "light.legacy");
    expect(loaded?.customName).toBe("Old");
    expect(missingSince(loaded)).toBeUndefined();
  });
});
