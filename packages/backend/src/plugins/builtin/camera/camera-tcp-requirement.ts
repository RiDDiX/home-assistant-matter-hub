import { readFileSync } from "node:fs";
import { pluginStorageFilePath } from "../../plugin-storage.js";

// #419: SmartThings sends a WebRTC offer larger than Matter's UDP message size,
// so a camera bridge needs a Matter TCP listener. Enable it exactly when the
// bridge has cameras configured.
export const CAMERA_TCP_CONFIG = { incoming: true, outgoing: false } as const;

// Split the comma-separated camera entity ids the same way camera-plugin does.
export function parseCameraList(cameras: unknown): string[] {
  if (typeof cameras !== "string") return [];
  return cameras
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// True when the bridge's persisted camera config lists at least one camera. A
// missing file, bad JSON or empty list all mean no cameras, so no tcp.
export function bridgeNeedsTcpForCameras(
  storageDir: string,
  bridgeId: string,
): boolean {
  try {
    const raw = readFileSync(
      pluginStorageFilePath(storageDir, bridgeId, "camera"),
      "utf-8",
    );
    const json = JSON.parse(raw) as { config?: { cameras?: unknown } };
    return parseCameraList(json.config?.cameras).length > 0;
  } catch {
    return false;
  }
}
