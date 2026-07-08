import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilePluginStorage } from "./plugin-storage.js";

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
