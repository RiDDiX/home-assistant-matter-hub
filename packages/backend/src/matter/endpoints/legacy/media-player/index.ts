import {
  type MediaPlayerDeviceAttributes,
  MediaPlayerDeviceClass,
  MediaPlayerDeviceFeature,
} from "@home-assistant-matter-hub/common";
import { SpeakerDevice } from "@matter/main/devices";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { VideoPlayerDevice } from "./basic-video-player.js";
import { MediaPlayerLevelControlServer } from "./behaviors/media-player-level-control-server.js";
import { MediaPlayerMediaInputServer } from "./behaviors/media-player-media-input-server.js";
import { MediaPlayerMediaPlaybackServer } from "./behaviors/media-player-media-playback-server.js";
import { MediaPlayerOnOffServer } from "./behaviors/media-player-on-off-server.js";
import { MediaPlayerPowerOnOffServer } from "./behaviors/media-player-power-on-off-server.js";

const SpeakerEndpointType = SpeakerDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
);

export function MediaPlayerDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
) {
  const attributes = homeAssistantEntity.entity.state
    .attributes as MediaPlayerDeviceAttributes;

  // Auto-detect TVs by device_class and use VideoPlayerDevice (#162)
  // TVs have better on/off support via BasicVideoPlayerDevice.
  // Explicit overrides to "speaker" bypass this by calling
  // SpeakerMediaPlayerDevice directly (#293).
  if (attributes.device_class === MediaPlayerDeviceClass.Tv) {
    return VideoPlayerDevice(homeAssistantEntity);
  }

  return SpeakerMediaPlayerDevice(homeAssistantEntity);
}

export function SpeakerMediaPlayerDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
) {
  const attributes = homeAssistantEntity.entity.state
    .attributes as MediaPlayerDeviceAttributes;
  const supportedFeatures = attributes.supported_features ?? 0;

  let device = SpeakerEndpointType;
  const supportsPower =
    testBit(supportedFeatures, MediaPlayerDeviceFeature.TURN_ON) &&
    testBit(supportedFeatures, MediaPlayerDeviceFeature.TURN_OFF);
  const supportsMute = testBit(
    supportedFeatures,
    MediaPlayerDeviceFeature.VOLUME_MUTE,
  );
  const supportsVolume = testBit(
    supportedFeatures,
    MediaPlayerDeviceFeature.VOLUME_SET,
  );

  // Use power control if supported, otherwise fall back to mute control
  if (supportsPower) {
    device = device.with(MediaPlayerPowerOnOffServer);
  } else if (supportsMute) {
    device = device.with(MediaPlayerOnOffServer);
  }

  if (supportsVolume) {
    // SpeakerLevelControlServer uses 0-254 range for Google Home compatibility
    device = device.with(MediaPlayerLevelControlServer);
  }

  if (testBit(supportedFeatures, MediaPlayerDeviceFeature.SELECT_SOURCE)) {
    device = device.with(MediaPlayerMediaInputServer);
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
