import type {
  HomeAssistantEntityState,
  LightDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import {
  type LevelControlConfig,
  LevelControlServer,
} from "../../../../behaviors/level-control-server.js";

const config: LevelControlConfig = {
  getValuePercent: (state: HomeAssistantEntityState<LightDeviceAttributes>) => {
    const brightness = state.attributes.brightness;
    if (brightness != null) {
      return brightness / 255;
    }
    // When brightness is unavailable (light off or not reported), return null
    // so currentLevel retains its last known value. If we return 0 here,
    // currentLevel resets to minLevel (1) which makes Apple Home default to
    // 100% on turn-on because it sees near-zero brightness (#225).
    return null;
  },
  moveToLevelPercent: (brightnessPercent) => ({
    action: "light.turn_on",
    data: {
      brightness: Math.round(brightnessPercent * 255),
    },
  }),
};

export const LightLevelControlServer = LevelControlServer(config).with(
  "OnOff",
  "Lighting",
);
