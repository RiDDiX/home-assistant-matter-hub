import {
  type HomeAssistantEntityState,
  type MediaPlayerDeviceAttributes,
  MediaPlayerDeviceFeature,
} from "@home-assistant-matter-hub/common";
import { testBit } from "../../../../../utils/test-bit.js";
import { OnOffServer } from "../../../../behaviors/on-off-server.js";

// A side HA does not support is null, so that command reverts to the HA state
// instead of flipping onOff locally.
export function MediaPlayerPowerOnOffServer(supportedFeatures: number) {
  return OnOffServer({
    isOn: (state: HomeAssistantEntityState<MediaPlayerDeviceAttributes>) => {
      return state.state !== "off" && state.state !== "standby";
    },
    turnOn: testBit(supportedFeatures, MediaPlayerDeviceFeature.TURN_ON)
      ? () => ({ action: "media_player.turn_on" })
      : null,
    turnOff: testBit(supportedFeatures, MediaPlayerDeviceFeature.TURN_OFF)
      ? () => ({ action: "media_player.turn_off" })
      : null,
  }).with();
}
