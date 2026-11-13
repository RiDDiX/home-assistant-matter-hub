import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FilePluginStorage,
  pluginStateFilePath,
  pluginStorageFilePath,
  removePluginFiles,
} from "./plugin-storage.js";

// #373: plugin config is edited per bridge but was stored in one file keyed by
// plugin name only, so every bridge shared the same config. The file must be
// scoped by bridgeId so two bridges keep separate plugin config.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-plugin-storage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FilePluginStorage per-bridge scope (#373)", () => {
  it("keeps config separate for two bridges running the same plugin", async () => {
    const a = new FilePluginStorage(dir, "bridge-a", "camera");
    await a.set("config", { cameras: "camera.front" });
    a.flush(); // set() debounces; flush so a second instance reads it

    const b = new FilePluginStorage(dir, "bridge-b", "camera");
    expect(await b.get("config")).toBeUndefined();

    await b.set("config", { cameras: "camera.garage" });
    b.flush();

    // Reloading either bridge must see only its own config.
    const a2 = new FilePluginStorage(dir, "bridge-a", "camera");
    expect(await a2.get("config")).toEqual({ cameras: "camera.front" });
    const b2 = new FilePluginStorage(dir, "bridge-b", "camera");
    expect(await b2.get("config")).toEqual({ cameras: "camera.garage" });
  });
});

describe("FilePluginStorage torn file", () => {
  it("keeps an unreadable file until a key changes, then replaces it whole", async () => {
    const file = pluginStorageFilePath(dir, "bridge-a", "camera");
    writeFileSync(file, '{"config": {"cam');

    const storage = new FilePluginStorage(dir, "bridge-a", "camera");
    expect(await storage.keys()).toEqual([]);
    storage.flush();
    expect(readFileSync(file, "utf-8")).toBe('{"config": {"cam');

    await storage.set("config", { cameras: "camera.front" });
    storage.flush();
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      config: { cameras: "camera.front" },
    });
  });
});

describe("removePluginFiles", () => {
  it("removes only the deleted bridge's files, not those of an id it prefixes", () => {
    const own = [
      pluginStorageFilePath(dir, "ab", "camera"),
      pluginStorageFilePath(dir, "ab", "vesync"),
      pluginStateFilePath(dir, "ab"),
    ];
    const kept = [
      pluginStorageFilePath(dir, "ab-x", "camera"),
      pluginStateFilePath(dir, "ab-x"),
      pluginStorageFilePath(dir, "cd", "camera"),
      join(dir, "bridges.json"),
    ];
    for (const file of [...own, ...kept]) writeFileSync(file, "{}");

    removePluginFiles(dir, "ab", ["ab-x", "cd"]);

    for (const file of own) expect(existsSync(file), file).toBe(false);
    for (const file of kept) expect(existsSync(file), file).toBe(true);
  });
});
