import {
  LawnMowerActivity,
  LawnMowerEntityFeature,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { RvcOperationalState } from "@matter/main/clusters";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { RvcOperationalStateServer } from "../../../../behaviors/rvc-operational-state-server.js";

const logger = Logger.get("LawnMowerRvcOperationalStateServer");

export function mapLawnMowerOperationalState(entity: {
  state: string;
}): RvcOperationalState.OperationalState {
  const state = entity.state as LawnMowerActivity | "unavailable";
  switch (state) {
    case LawnMowerActivity.mowing:
      return RvcOperationalState.OperationalState.Running;
    case LawnMowerActivity.returning:
      return RvcOperationalState.OperationalState.SeekingCharger;
    case LawnMowerActivity.docked:
      // Lawn mowers rarely report a charging signal, so report Docked.
      return RvcOperationalState.OperationalState.Docked;
    case LawnMowerActivity.paused:
      return RvcOperationalState.OperationalState.Paused;
    case LawnMowerActivity.error:
    case "unavailable":
      return RvcOperationalState.OperationalState.Error;
    default:
      logger.info(`Unknown lawn_mower state "${state}", treating as Stopped`);
      return RvcOperationalState.OperationalState.Stopped;
  }
}

export const LawnMowerRvcOperationalStateServer = RvcOperationalStateServer({
  getOperationalState: (entity) => mapLawnMowerOperationalState(entity),
  // Pause requires the PAUSE feature; mowers without it can only be docked.
  pause: (_, agent) => {
    const features =
      agent.get(HomeAssistantEntityBehavior).entity.state.attributes
        .supported_features ?? 0;
    if (testBit(features, LawnMowerEntityFeature.PAUSE)) {
      return { action: "lawn_mower.pause" };
    }
    return { action: "lawn_mower.dock" };
  },
  resume: () => ({ action: "lawn_mower.start_mowing" }),
  goHome: () => ({ action: "lawn_mower.dock" }),
});
