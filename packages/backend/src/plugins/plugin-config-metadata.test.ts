import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CameraPlugin } from "./builtin/camera/camera-plugin.js";
import { PluginManager } from "./plugin-manager.js";
import { pluginStorageFilePath } from "./plugin-storage.js";

// GET /api/plugins reported config {} after every restart: the camera merged
// its persisted file config into a private field during onStart but never back
// into the metadata the API serves, so the config dialog opened empty.

const dir = fs.mkdtempSync(join(tmpdir(), "hamh-config-meta-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("plugin metadata config", () => {
  it("reports the persisted config after a restart", async () => {
    const file = pluginStorageFilePath(dir, "bridge-1", "camera");
    fs.writeFileSync(file, JSON.stringify({ config: { cameras: "camera.x" } }));

    const pm = new PluginManager("bridge-1", dir);
    await pm.registerBuiltIn(new CameraPlugin());
    await pm.startAll();

    expect(pm.getMetadata()[0].config).toEqual({ cameras: "camera.x" });
    await pm.shutdownAll();
  });

  it("keeps the stored token when a save sends the placeholder", async () => {
    const pm = new PluginManager("bridge-3", dir);
    await pm.registerBuiltIn(new CameraPlugin());
    await pm.startAll();

    await pm.updateConfig("camera", {
      cameras: "camera.x",
      haToken: "real-token",
    });
    // The dialog round-trips redacted values as "__unchanged__"; storing that
    // literal would destroy the token.
    await pm.updateConfig("camera", {
      cameras: "camera.y",
      haToken: "__unchanged__",
    });

    expect(pm.getMetadata()[0].config).toEqual({
      cameras: "camera.y",
      haToken: "real-token",
    });
    await pm.shutdownAll();
  });

  it("clears a secret the save leaves out entirely", async () => {
    const pm = new PluginManager("bridge-4", dir);
    await pm.registerBuiltIn(new CameraPlugin());
    await pm.startAll();

    await pm.updateConfig("camera", {
      cameras: "camera.x",
      haToken: "real-token",
    });
    await pm.updateConfig("camera", { cameras: "camera.x" });

    expect(pm.getMetadata()[0].config).toEqual({ cameras: "camera.x" });
    await pm.shutdownAll();
  });

  it("updateConfig still overwrites the metadata and the file", async () => {
    const pm = new PluginManager("bridge-2", dir);
    await pm.registerBuiltIn(new CameraPlugin());
    await pm.startAll();

    const ok = await pm.updateConfig("camera", { cameras: "camera.y" });
    expect(ok).toBe(true);
    expect(pm.getMetadata()[0].config).toEqual({ cameras: "camera.y" });

    // shutdown flushes the debounced plugin storage
    await pm.shutdownAll();
    const file = pluginStorageFilePath(dir, "bridge-2", "camera");
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.config).toEqual({ cameras: "camera.y" });
  });
});
