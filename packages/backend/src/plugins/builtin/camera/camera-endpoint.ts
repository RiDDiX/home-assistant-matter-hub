import { CameraAvStreamManagement } from "@matter/main/clusters";
import { CameraDevice } from "@matter/main/devices";
import { StreamUsage } from "@matter/types";
import { CameraAvStreamServer } from "./av-stream-server.js";
import type { WebRtcBridge } from "./webrtc-bridge.js";
import { CameraWebRtcProviderServer } from "./webrtc-provider-server.js";

// Video sensor geometry the Matter cluster wants up front. Mandatory under the
// Video feature, so it has to be set or the endpoint fails conformance on init.
export interface CameraSensorParams {
  sensorWidth: number;
  sensorHeight: number;
  maxFps: number;
}

export const defaultSensorParams: CameraSensorParams = {
  sensorWidth: 1920,
  sensorHeight: 1080,
  maxFps: 30,
};

// Builds the Matter Camera (0x0142) endpoint and injects the bridge + entity id.
// The capability defaults below are sane guesses, not verified on a controller.
export function createCameraEndpointType(
  bridge: WebRtcBridge,
  entityId: string,
  sensor: CameraSensorParams = defaultSensorParams,
) {
  return CameraDevice.with(
    CameraAvStreamServer,
    CameraWebRtcProviderServer,
  ).set({
    webRtcTransportProvider: {
      bridge,
      entityId,
      currentSessions: [],
      nextSessionId: 1,
    },
    cameraAvStreamManagement: {
      bridge,
      entityId,
      supportedStreamUsages: [StreamUsage.LiveView],
      streamUsagePriorities: [StreamUsage.LiveView],
      allocatedVideoStreams: [],
      allocatedSnapshotStreams: [],
      maxConcurrentEncoders: 1,
      maxEncodedPixelRate: 3840 * 2160 * 30,
      maxNetworkBandwidth: 20_000_000, // 20 Mbps, attribute is bits per second
      currentFrameRate: 0,
      videoSensorParams: {
        sensorWidth: sensor.sensorWidth,
        sensorHeight: sensor.sensorHeight,
        maxFps: sensor.maxFps,
      },
      viewport: {
        x1: 0,
        y1: 0,
        x2: sensor.sensorWidth,
        y2: sensor.sensorHeight,
      },
      minViewportResolution: { width: 64, height: 64 },
      rateDistortionTradeOffPoints: [
        {
          codec: CameraAvStreamManagement.VideoCodec.H264,
          resolution: {
            width: sensor.sensorWidth,
            height: sensor.sensorHeight,
          },
          minBitRate: 10_000,
        },
      ],
      maxContentBufferSize: 1_048_576, // one snapshot jpeg in flight
      // ImageControl attributes: matter.js conformance (since 0.17.5) forces the
      // feature. Controllers can write these but the proxied HA media path
      // never applies a transform.
      imageRotation: 0,
      imageFlipHorizontal: false,
      imageFlipVertical: false,
      snapshotCapabilities: [
        {
          resolution: {
            width: sensor.sensorWidth,
            height: sensor.sensorHeight,
          },
          maxFrameRate: 1,
          imageCodec: CameraAvStreamManagement.ImageCodec.Jpeg,
          requiresEncodedPixels: false,
        },
      ],
      nextVideoStreamId: 1,
      nextSnapshotStreamId: 1,
    },
  });
}
