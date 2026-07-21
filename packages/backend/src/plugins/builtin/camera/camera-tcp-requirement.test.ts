import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FilePluginStorage,
  pluginStorageFilePath,
} from "../../plugin-storage.js";
import { bridgeNeedsTcpForCameras } from "./camera-tcp-requirement.js";

// #419: TCP is enabled per bridge based on that bridge's persisted camera list.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-camera-tcp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCameraFile(bridgeId: string, content: string): void {
  writeFileSync(pluginStorageFilePath(dir, bridgeId, "camera"), content);
}

describe("bridgeNeedsTcpForCameras (#419)", () => {
  it("is false when no config file exists", () => {
    expect(bridgeNeedsTcpForCameras(dir, "bridge-missing")).toBe(false);
  });

  it("is false for an empty camera list", () => {
    writeCameraFile(
      "bridge-empty",
      JSON.stringify({ config: { cameras: "" } }),
    );
    expect(bridgeNeedsTcpForCameras(dir, "bridge-empty")).toBe(false);
  });

  it("is true when cameras are configured", () => {
    writeCameraFile(
      "bridge-two",
      JSON.stringify({ config: { cameras: " camera.a , camera.b " } }),
    );
    expect(bridgeNeedsTcpForCameras(dir, "bridge-two")).toBe(true);
  });

  it("is false for malformed json", () => {
    writeCameraFile("bridge-bad", "{ not json");
    expect(bridgeNeedsTcpForCameras(dir, "bridge-bad")).toBe(false);
  });

  it("is true for a config written through FilePluginStorage", async () => {
    const storage = new FilePluginStorage(dir, "bridge-live", "camera");
    await storage.set("config", { cameras: "camera.x" });
    storage.flush();
    expect(bridgeNeedsTcpForCameras(dir, "bridge-live")).toBe(true);
  });
});
