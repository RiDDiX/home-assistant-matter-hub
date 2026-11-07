import type { MediaPlayerDeviceAttributes } from "@home-assistant-matter-hub/common";
import { SpeakerLevelControlServer } from "../../../../behaviors/speaker-level-control-server.js";

/**
 * LevelControl for MediaPlayer/Speaker devices.
 *
 * Uses SpeakerLevelControlServer which:
 * - Does NOT use the "Lighting" feature
 * - Uses range 0-254 for currentLevel (Google Home calculates percentage as currentLevel/254)
 *
 * This fixes Issue #79 where Google Home displayed wrong volume percentages
 * because it interpreted currentLevel (0-254) as a percentage value.
 */
export const MediaPlayerLevelControlServer = SpeakerLevelControlServer({
  getValuePercent: (state) => {
    const attributes = state.attributes as MediaPlayerDeviceAttributes;
    if (attributes.volume_level != null) {
      return attributes.volume_level;
    }
    return 0;
  },
  moveToLevelPercent: (value) => {
    return {
      action: "media_player.volume_set",
      data: { volume_level: value },
    };
  },
});

// Without VOLUME_SET the level still follows volume_level, but commands
// change nothing, otherwise matter.js would move the slider locally only.
export class MediaPlayerReadOnlyLevelControlServer extends MediaPlayerLevelControlServer {
  override moveToLevelLogic() {}
  override moveLogic() {}
  override stepLogic() {}
}
