import { Logger } from "@matter/general";
import type {
  MatterHubPlugin,
  PluginConfigSchema,
  PluginContext,
} from "../../types.js";
import { createCameraEndpointType } from "./camera-endpoint.js";
import { WebRtcBridge } from "./webrtc-bridge.js";

interface CameraConfig {
  haUrl?: string;
  haToken?: string;
  // Comma-separated HA camera entity ids, e.g. "camera.front,camera.garage".
  cameras?: string;
}

const CONFIG_KEY = "config";

// Exposes HA cameras as Matter Cameras (0x0142). Built-in so it shares the
// bundled matter.js instance. Experimental: WebRTC media path is unverified.
export class CameraPlugin implements MatterHubPlugin {
  readonly name = "camera";
  readonly version = "0.1.0";

  private readonly log = Logger.get("CameraPlugin");
  private context?: PluginContext;
  private bridge?: WebRtcBridge;
  private deviceIds: string[] = [];
  private config: CameraConfig;

  constructor(config: CameraConfig = {}) {
    this.config = config;
  }

  async onStart(context: PluginContext): Promise<void> {
    this.context = context;
    // Persisted config wins; the constructor value is just a seed.
    const stored = await context.storage.get<CameraConfig>(CONFIG_KEY);
    this.config = { ...this.config, ...(stored ?? {}) };
    await this.apply();
  }

  async onConfigChanged(config: Record<string, unknown>): Promise<void> {
    this.config = config as CameraConfig;
    await this.context?.storage.set(CONFIG_KEY, this.config);
    await this.apply();
  }

  async onShutdown(): Promise<void> {
    await this.teardown();
  }

  getConfigSchema(): PluginConfigSchema {
    return {
      title: "Camera",
      description: "Expose Home Assistant cameras as Matter cameras.",
      properties: {
        haUrl: {
          type: "string",
          title: "Home Assistant URL",
          description:
            "e.g. http://homeassistant.local:8123. Leave empty to use the bridge's Home Assistant connection.",
          required: false,
        },
        haToken: {
          type: "string",
          title: "Long-lived access token",
          description:
            "Leave empty to use the bridge's Home Assistant connection.",
          required: false,
        },
        cameras: {
          type: "string",
          title: "Camera entity ids (comma-separated)",
          description: "e.g. camera.front,camera.garage",
          required: true,
        },
      },
    };
  }

  // (Re)build all camera endpoints from the current config.
  private async apply(): Promise<void> {
    const context = this.context;
    if (!context) return;
    await this.teardown();

    // Fall back to the bridge's HA connection when none is set in config.
    const haUrl = this.config.haUrl ?? context.homeAssistant?.url;
    const haToken = this.config.haToken ?? context.homeAssistant?.accessToken;
    const cameras = this.config.cameras;
    if (!haUrl || !haToken) {
      this.log.info("no Home Assistant connection, no cameras exposed");
      return;
    }
    const entityIds = (cameras ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (entityIds.length === 0) {
      this.log.info("no camera entity ids configured");
      return;
    }

    this.bridge = new WebRtcBridge({ haUrl, haToken });
    for (const entityId of entityIds) {
      const id = entityId.replace(/\./g, "_");
      await context.registerDevice({
        id,
        name: entityId,
        endpointType: createCameraEndpointType(this.bridge, entityId),
        clusters: [],
      });
      this.deviceIds.push(id);
    }
    this.log.info(`Exposed ${this.deviceIds.length} camera(s)`);
  }

  private async teardown(): Promise<void> {
    for (const id of this.deviceIds) {
      await this.context?.unregisterDevice(id).catch(() => {});
    }
    this.deviceIds = [];
    await this.bridge?.close().catch(() => {});
    this.bridge = undefined;
  }
}
