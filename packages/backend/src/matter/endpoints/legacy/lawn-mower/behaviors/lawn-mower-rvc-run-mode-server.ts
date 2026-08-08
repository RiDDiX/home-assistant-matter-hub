import {
  LawnMowerActivity,
  LawnMowerEntityFeature,
} from "@home-assistant-matter-hub/common";
import { RvcRunMode } from "@matter/main/clusters";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  RvcRunModeServer,
  RvcSupportedRunMode,
} from "../../../../behaviors/rvc-run-mode-server.js";

const supportedModes: RvcRunMode.ModeOption[] = [
  {
    label: "Idle",
    mode: RvcSupportedRunMode.Idle,
    modeTags: [{ value: RvcRunMode.ModeTag.Idle }],
  },
  {
    label: "Mowing",
    mode: RvcSupportedRunMode.Cleaning,
    modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }],
  },
];

export function mapLawnMowerRunMode(entity: {
  state: string;
}): RvcSupportedRunMode {
  const state = entity.state as LawnMowerActivity;
  // paused stays Cleaning: the Matter spec requires Cleaning mode when
  // OperationalState is Paused.
  const active =
    state === LawnMowerActivity.mowing || state === LawnMowerActivity.paused;
  return active ? RvcSupportedRunMode.Cleaning : RvcSupportedRunMode.Idle;
}

export function createLawnMowerRvcRunModeServer() {
  return RvcRunModeServer(
    {
      getCurrentMode: (entity) => mapLawnMowerRunMode(entity),
      getSupportedModes: () => supportedModes,
      start: () => ({ action: "lawn_mower.start_mowing" }),
      returnToBase: () => ({ action: "lawn_mower.dock" }),
      pause: (_, agent) => {
        const features =
          agent.get(HomeAssistantEntityBehavior).entity.state.attributes
            .supported_features ?? 0;
        if (testBit(features, LawnMowerEntityFeature.PAUSE)) {
          return { action: "lawn_mower.pause" };
        }
        return { action: "lawn_mower.dock" };
      },
    },
    { supportedModes, currentMode: RvcSupportedRunMode.Idle },
  );
}
