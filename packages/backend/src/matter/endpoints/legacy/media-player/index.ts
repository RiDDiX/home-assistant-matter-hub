import {
  type MediaPlayerDeviceAttributes,
  MediaPlayerDeviceFeature,
} from "@home-assistant-matter-hub/common";
import { SpeakerDevice } from "@matter/main/devices";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import type { LevelControlFeatures } from "../../../behaviors/level-control-server.js";
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
    const volumeFeatures: LevelControlFeatures = [];
    if (supportsPower || supportsMute) {
      volumeFeatures.push("OnOff");
    }
    device = device.with(MediaPlayerLevelControlServer.with(...volumeFeatures));
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
