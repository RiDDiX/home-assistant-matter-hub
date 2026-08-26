import { readFileSync } from "node:fs";
import type { BridgeFeatureFlags } from "@home-assistant-matter-hub/common";
import { pluginStorageFilePath } from "../../plugin-storage.js";

// #419: SmartThings sends a WebRTC offer larger than Matter's UDP message size,
// so a camera bridge needs a Matter TCP listener. Enable it exactly when the
// bridge has cameras configured.
export const CAMERA_TCP_CONFIG = { incoming: true, outgoing: false } as const;

// #449: the enableMatterTcp flag must also catch a node kept across a bridge
// restart, tcp is otherwise only copied at construction. Enable only; turning
// it off is documented as a matterhub restart.
export async function applyTcpFlagBeforeStart(
  server: {
    state: { network: { tcp?: unknown } };
    set(values: object): Promise<void>;
  },
  flags?: BridgeFeatureFlags,
): Promise<void> {
  if (!flags?.enableMatterTcp || server.state.network.tcp) {
    return;
  }
  await server.set({ network: { tcp: CAMERA_TCP_CONFIG } });
}

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
