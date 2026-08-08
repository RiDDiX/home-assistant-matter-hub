import {
  type CoverDeviceAttributes,
  CoverDeviceState,
  CoverSupportedFeatures,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import { DimmableLightDevice } from "@matter/main/devices";
import type { HomeAssistantAction } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { LevelControlServer } from "../../../../behaviors/level-control-server.js";
import { OnOffServer } from "../../../../behaviors/on-off-server.js";
import { DefaultPowerSourceServer } from "../../../../behaviors/power-source-server.js";
import { liftShouldUseTilt } from "./cover-window-covering-server.js";

// Cover exposed as a Dimmable Light so Alexa can still drive it: level is the
// open percentage, on/off is open/close (#372). Direct mapping, the cover
// invert/swap flags only apply to the real WindowCovering path.

const attributes = (entity: HomeAssistantEntityState) =>
  entity.attributes as CoverDeviceAttributes;

/** Cover openness as a 0..1 fraction, or null when it can't be determined. */
export function coverOpenness(entity: HomeAssistantEntityState): number | null {
  const position = attributes(entity).current_position;
  if (position != null) {
    return Math.min(1, Math.max(0, position / 100));
  }
  // Tilt-only covers report tilt position, not lift position.
  const tilt = attributes(entity).current_tilt_position;
  if (tilt != null) {
    return Math.min(1, Math.max(0, tilt / 100));
  }
  if (entity.state === CoverDeviceState.open) return 1;
  if (entity.state === CoverDeviceState.closed) return 0;
  return null;
}

/** Map a light level (0..1) to the matching cover service call. */
export function coverLevelAction(
  percent: number,
  supportedFeatures: number,
): HomeAssistantAction {
  const position = Math.round(Math.min(1, Math.max(0, percent)) * 100);
  // Tilt-only covers reject lift services, so drive them through tilt (#350).
  if (liftShouldUseTilt(supportedFeatures)) {
    if (
      (supportedFeatures & CoverSupportedFeatures.support_set_tilt_position) !==
      0
    ) {
      return {
        action: "cover.set_cover_tilt_position",
        data: { tilt_position: position },
      };
    }
    return {
      action:
        position >= 50 ? "cover.open_cover_tilt" : "cover.close_cover_tilt",
    };
  }
  if ((supportedFeatures & CoverSupportedFeatures.support_set_position) !== 0) {
    return { action: "cover.set_cover_position", data: { position } };
  }
  // No position support: treat the upper half as open, the lower half as close.
  return { action: position >= 50 ? "cover.open_cover" : "cover.close_cover" };
}

const supportedFeaturesOf = (agent: Agent): number =>
  attributes(agent.get(HomeAssistantEntityBehavior).entity.state)
    .supported_features ?? 0;

// Open/close a tilt-routed cover. A set-tilt-position-only cover has no discrete
// tilt service, so drive it to the fully open (100) / closed (0) tilt (#405).
export function tiltOpenClose(
  open: boolean,
  supportedFeatures: number,
): HomeAssistantAction {
  if (
    (supportedFeatures & CoverSupportedFeatures.support_set_tilt_position) !==
    0
  ) {
    return {
      action: "cover.set_cover_tilt_position",
      data: { tilt_position: open ? 100 : 0 },
    };
  }
  return { action: open ? "cover.open_cover_tilt" : "cover.close_cover_tilt" };
}

const CoverAsLightOnOffServer = OnOffServer({
  isOn: (entity) => entity.state !== CoverDeviceState.closed,
  turnOn: (_value, agent) => {
    const sf = supportedFeaturesOf(agent);
    return liftShouldUseTilt(sf)
      ? tiltOpenClose(true, sf)
      : { action: "cover.open_cover" };
  },
  turnOff: (_value, agent) => {
    const sf = supportedFeaturesOf(agent);
    return liftShouldUseTilt(sf)
      ? tiltOpenClose(false, sf)
      : { action: "cover.close_cover" };
  },
});

const CoverAsLightLevelControlServer = LevelControlServer({
  getValuePercent: (entity) => coverOpenness(entity),
  moveToLevelPercent: (percent, agent) =>
    coverLevelAction(percent, supportedFeaturesOf(agent)),
});

const baseBehaviors = [
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  CoverAsLightOnOffServer,
  CoverAsLightLevelControlServer,
] as const;

export const CoverAsDimmableLightType = DimmableLightDevice.with(
  ...baseBehaviors,
);

export const CoverAsDimmableLightWithBatteryType = DimmableLightDevice.with(
  ...baseBehaviors,
  DefaultPowerSourceServer,
);
