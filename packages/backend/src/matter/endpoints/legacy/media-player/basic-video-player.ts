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
import { MediaPlayerKeypadInputServer } from "./behaviors/media-player-keypad-input-server.js";
import { MediaPlayerMediaInputServer } from "./behaviors/media-player-media-input-server.js";
import { MediaPlayerMediaPlaybackServer } from "./behaviors/media-player-media-playback-server.js";
import { MediaPlayerPowerOnOffServer } from "./behaviors/media-player-power-on-off-server.js";

// BasicVideoPlayerDevice (deviceType 40) for TVs
// Required behaviors: onOff, mediaPlayback, keypadInput
// MediaPlayback stays even without PLAY/PAUSE, the bare matter.js server has
// no currentState and the endpoint fails to initialize.
const VideoPlayerEndpointType = BasicVideoPlayerDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  MediaPlayerKeypadInputServer,
  MediaPlayerMediaPlaybackServer,
);

export function VideoPlayerDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as MediaPlayerDeviceAttributes;
  const supportedFeatures = attributes.supported_features ?? 0;

  // OnOff is mandatory, without the HA-bound server matter.js keeps its own
  // that flips locally and never follows HA.
  let device = VideoPlayerEndpointType.with(
    MediaPlayerPowerOnOffServer(supportedFeatures),
  );

  if (testBit(supportedFeatures, MediaPlayerDeviceFeature.SELECT_SOURCE)) {
    device = device.with(MediaPlayerMediaInputServer);
  }

  return device.set({ homeAssistantEntity });
}
