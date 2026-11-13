import {
  type MediaPlayerDeviceAttributes,
  MediaPlayerDeviceFeature,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { KeypadInputServer as Base } from "@matter/main/behaviors";
import { KeypadInput } from "@matter/main/clusters";
import type { HomeAssistantAction } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

const logger = Logger.get("MediaPlayerKeypadInputServer");

export class MediaPlayerKeypadInputServer extends Base {
  override sendKey(
    request: KeypadInput.SendKeyRequest,
  ): KeypadInput.SendKeyResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return { status: KeypadInput.Status.InvalidKeyInCurrentState };
    }

    const attributes = homeAssistant.entity.state
      .attributes as MediaPlayerDeviceAttributes;
    const action = this.mapKeyToAction(request.keyCode, attributes);

    if (!action) {
      logger.debug(
        `Unsupported key code ${request.keyCode} for ${homeAssistant.entityId}`,
      );
      return { status: KeypadInput.Status.UnsupportedKey };
    }

    logger.debug(
      `sendKey(${request.keyCode}) → ${action.action} for ${homeAssistant.entityId}`,
    );
    homeAssistant.callAction(action);
    return { status: KeypadInput.Status.Success };
  }

  private mapKeyToAction(
    keyCode: KeypadInput.CecKeyCode,
    attributes: MediaPlayerDeviceAttributes,
  ): HomeAssistantAction | undefined {
    const features = attributes.supported_features ?? 0;
    // HA requires is_volume_muted on volume_mute
    const mute = (muted: boolean): HomeAssistantAction | undefined =>
      testBit(features, MediaPlayerDeviceFeature.VOLUME_MUTE)
        ? {
            action: "media_player.volume_mute",
            data: { is_volume_muted: muted },
          }
        : undefined;
    switch (keyCode) {
      // Playback
      case KeypadInput.CecKeyCode.Play:
      case KeypadInput.CecKeyCode.PlayFunction:
        if (testBit(features, MediaPlayerDeviceFeature.PLAY)) {
          return { action: "media_player.media_play" };
        }
        return undefined;

      case KeypadInput.CecKeyCode.Pause:
      case KeypadInput.CecKeyCode.PausePlayFunction:
        if (testBit(features, MediaPlayerDeviceFeature.PAUSE)) {
          return { action: "media_player.media_pause" };
        }
        return undefined;

      case KeypadInput.CecKeyCode.Stop:
      case KeypadInput.CecKeyCode.StopFunction:
        if (testBit(features, MediaPlayerDeviceFeature.STOP)) {
          return { action: "media_player.media_stop" };
        }
        return undefined;

      // Track navigation
      case KeypadInput.CecKeyCode.Forward:
      case KeypadInput.CecKeyCode.FastForward:
        if (testBit(features, MediaPlayerDeviceFeature.NEXT_TRACK)) {
          return { action: "media_player.media_next_track" };
        }
        return undefined;

      case KeypadInput.CecKeyCode.Backward:
      case KeypadInput.CecKeyCode.Rewind:
        if (testBit(features, MediaPlayerDeviceFeature.PREVIOUS_TRACK)) {
          return { action: "media_player.media_previous_track" };
        }
        return undefined;

      // Volume
      case KeypadInput.CecKeyCode.VolumeUp:
        if (testBit(features, MediaPlayerDeviceFeature.VOLUME_STEP)) {
          return { action: "media_player.volume_up" };
        }
        return undefined;

      case KeypadInput.CecKeyCode.VolumeDown:
        if (testBit(features, MediaPlayerDeviceFeature.VOLUME_STEP)) {
          return { action: "media_player.volume_down" };
        }
        return undefined;

      case KeypadInput.CecKeyCode.Mute:
        return mute(!attributes.is_volume_muted);

      case KeypadInput.CecKeyCode.MuteFunction:
        return mute(true);

      case KeypadInput.CecKeyCode.RestoreVolumeFunction:
        return mute(false);

      // Power
      case KeypadInput.CecKeyCode.Power:
      case KeypadInput.CecKeyCode.PowerToggleFunction:
        if (
          testBit(features, MediaPlayerDeviceFeature.TURN_ON) &&
          testBit(features, MediaPlayerDeviceFeature.TURN_OFF)
        ) {
          return { action: "media_player.toggle" };
        }
        return undefined;

      case KeypadInput.CecKeyCode.PowerOnFunction:
        if (testBit(features, MediaPlayerDeviceFeature.TURN_ON)) {
          return { action: "media_player.turn_on" };
        }
        return undefined;

      case KeypadInput.CecKeyCode.PowerOffFunction:
        if (testBit(features, MediaPlayerDeviceFeature.TURN_OFF)) {
          return { action: "media_player.turn_off" };
        }
        return undefined;

      default:
        return undefined;
    }
  }
}
