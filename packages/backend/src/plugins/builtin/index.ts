import type { MatterHubPlugin } from "../types.js";
import { CameraPlugin } from "./camera/camera-plugin.js";

// The one list of built-in plugins. The bridge registers these on start and the
// install API rejects their names, both from here so the two cannot drift.
export const BUILTIN_PLUGINS: ReadonlyArray<new () => MatterHubPlugin> = [
  CameraPlugin,
];
