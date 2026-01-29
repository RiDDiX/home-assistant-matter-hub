import {
  type MediaPlayerDeviceAttributes,
  MediaPlayerDeviceFeature,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { BasicVideoPlayerDevice } from "@matter/main/devices";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { MediaPlayerMediaPlaybackServer } from "./behaviors/media-player-media-playback-server.js";
import { MediaPlayerPowerOnOffServer } from "./behaviors/media-player-power-on-off-server.js";

// BasicVideoPlayerDevice (deviceType 40) for TVs
// Required behaviors: onOff, mediaPlayback, keypadInput
// We implement onOff and mediaPlayback, keypadInput uses default
const VideoPlayerEndpointType = BasicVideoPlayerDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
);

export function VideoPlayerDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as MediaPlayerDeviceAttributes;
  const supportedFeatures = attributes.supported_features ?? 0;

  let device = VideoPlayerEndpointType;

  // Add power control if supported
  const supportsPower =
    testBit(supportedFeatures, MediaPlayerDeviceFeature.TURN_ON) &&
    testBit(supportedFeatures, MediaPlayerDeviceFeature.TURN_OFF);
  if (supportsPower) {
    device = device.with(MediaPlayerPowerOnOffServer);
  }

  // Add playback controls if play or pause is supported
  const supportsPlay = testBit(
    supportedFeatures,
    MediaPlayerDeviceFeature.PLAY,
  );
  const supportsPause = testBit(
    supportedFeatures,
    MediaPlayerDeviceFeature.PAUSE,
  );
  if (supportsPlay || supportsPause) {
    device = device.with(MediaPlayerMediaPlaybackServer);
  }

  return device.set({ homeAssistantEntity });
}
