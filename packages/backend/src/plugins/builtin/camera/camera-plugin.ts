import { Logger } from "@matter/general";
import type {
  MatterHubPlugin,
  PluginConfigSchema,
  PluginContext,
} from "../../types.js";
import {
  type CameraSensorParams,
  createCameraEndpointType,
  defaultSensorParams,
} from "./camera-endpoint.js";
import { parseCameraList } from "./camera-tcp-requirement.js";
import { unregisterAllRequestors } from "./requestor-client.js";
import { WebRtcBridge } from "./webrtc-bridge.js";

interface CameraConfig {
  haUrl?: string;
  haToken?: string;
  // Comma-separated HA camera entity ids, e.g. "camera.front,camera.garage".
  cameras?: string;
  sensorWidth?: number;
  sensorHeight?: number;
  maxFps?: number;
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

  getCurrentConfig(): Record<string, unknown> {
    return { ...this.config };
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
          secret: true,
        },
        cameras: {
          type: "string",
          title: "Camera entity ids (comma-separated)",
          description: "e.g. camera.front,camera.garage",
          required: true,
        },
        sensorWidth: {
          type: "number",
          title: "Sensor width (px)",
          description: "Video sensor width reported to controllers.",
          default: defaultSensorParams.sensorWidth,
          required: false,
        },
        sensorHeight: {
          type: "number",
          title: "Sensor height (px)",
          description: "Video sensor height reported to controllers.",
          default: defaultSensorParams.sensorHeight,
          required: false,
        },
        maxFps: {
          type: "number",
          title: "Max frame rate (fps)",
          description: "Maximum frame rate the sensor supports.",
          default: defaultSensorParams.maxFps,
          required: false,
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
    const entityIds = parseCameraList(cameras);
    if (entityIds.length === 0) {
      this.log.info("no camera entity ids configured");
      return;
    }

    const sensor = this.sensorParams();
    this.bridge = new WebRtcBridge({ haUrl, haToken });
    for (const entityId of entityIds) {
      const id = entityId.replace(/\./g, "_");
      await context.registerDevice({
        id,
        name: entityId,
        endpointType: createCameraEndpointType(this.bridge, entityId, sensor),
        clusters: [],
      });
      this.deviceIds.push(id);
    }
    this.log.info(`Exposed ${this.deviceIds.length} camera(s)`);
  }

  // Clamp the configured sensor to values the cluster accepts; a bad or missing
  // entry falls back to the default for that field.
  private sensorParams(): CameraSensorParams {
    const dim = (n: unknown, fallback: number): number =>
      typeof n === "number" && Number.isFinite(n)
        ? Math.min(65535, Math.max(64, Math.floor(n)))
        : fallback;
    const fps = (n: unknown, fallback: number): number =>
      typeof n === "number" && Number.isFinite(n)
        ? Math.min(65535, Math.max(1, Math.floor(n)))
        : fallback;
    return {
      sensorWidth: dim(
        this.config.sensorWidth,
        defaultSensorParams.sensorWidth,
      ),
      sensorHeight: dim(
        this.config.sensorHeight,
        defaultSensorParams.sensorHeight,
      ),
      maxFps: fps(this.config.maxFps, defaultSensorParams.maxFps),
    };
  }

  private async teardown(): Promise<void> {
    for (const id of this.deviceIds) {
      await this.context?.unregisterDevice(id).catch(() => {});
    }
    this.deviceIds = [];
    await this.bridge?.close().catch(() => {});
    this.bridge = undefined;
    // Cancel pending answer deliveries so no timer outlives the endpoints.
    unregisterAllRequestors();
  }
}
