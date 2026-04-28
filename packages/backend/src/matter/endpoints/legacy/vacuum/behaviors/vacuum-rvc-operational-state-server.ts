import {
  VacuumDeviceFeature,
  VacuumState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { RvcOperationalState } from "@matter/main/clusters";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { RvcOperationalStateServer } from "../../../../behaviors/rvc-operational-state-server.js";

const logger = Logger.get("VacuumRvcOperationalStateServer");

interface ChargingAttributes {
  battery_icon?: string;
  is_charging?: boolean;
  charging?: boolean;
  status?: string;
}

function isCharging(entity: { attributes: Record<string, unknown> }): boolean {
  const attrs = entity.attributes as ChargingAttributes;
  if (attrs.battery_icon?.includes("charging")) return true;
  if (attrs.is_charging === true || attrs.charging === true) return true;
  if (
    typeof attrs.status === "string" &&
    attrs.status.toLowerCase().includes("charg")
  )
    return true;
  return false;
}

export const VacuumRvcOperationalStateServer = RvcOperationalStateServer({
  async initialize() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);

    const updateCache = () => {
      const newState = this.getOperationalState(
        homeAssistant.entity.state,
        this.agent,
      );
      this.state.operationalState = newState;
    };

    this.react(homeAssistant.entity.state, updateCache);
    updateCache();
  },

  getOperationalState(entity) {
    if (entity === this.state) return this.state.operationalState;
    const state = entity.state as VacuumState | "unavailable";

    const cleaningStates: string[] = [
      VacuumState.cleaning,
      VacuumState.segment_cleaning,
      VacuumState.zone_cleaning,
      VacuumState.spot_cleaning,
      VacuumState.mop_cleaning,
    ];

    let operationalState: RvcOperationalState.OperationalState;

    if (state === VacuumState.docked) {
      if (isCharging(entity)) {
        operationalState = RvcOperationalState.OperationalState.Charging;
      } else {
        operationalState = RvcOperationalState.OperationalState.Docked;
      }
    } else if (state === VacuumState.returning) {
      operationalState = RvcOperationalState.OperationalState.SeekingCharger;
    } else if (cleaningStates.includes(state)) {
      operationalState = RvcOperationalState.OperationalState.Running;
    } else if (state === VacuumState.paused) {
      operationalState = RvcOperationalState.OperationalState.Paused;
    } else if (state === VacuumState.idle) {
      // Idle could mean docked/charging or just idle
      if (isCharging(entity)) {
        operationalState = RvcOperationalState.OperationalState.Charging;
      } else {
        operationalState = RvcOperationalState.OperationalState.Stopped;
      }
    } else if (state === VacuumState.error || state === "unavailable") {
      operationalState = RvcOperationalState.OperationalState.Error;
    } else {
      // Unknown state - log it and treat as Running if it contains "clean"
      if (state.toLowerCase().includes("clean")) {
        logger.info(
          `Unknown vacuum state "${state}" contains 'clean', treating as Running`,
        );
        operationalState = RvcOperationalState.OperationalState.Running;
      } else {
        logger.info(`Unknown vacuum state "${state}", treating as Stopped`);
        operationalState = RvcOperationalState.OperationalState.Stopped;
      }
    }

    logger.debug(
      `Vacuum operationalState: "${state}" -> ${RvcOperationalState.OperationalState[operationalState]}`,
    );
    return operationalState;
  },
  pause: (_, agent) => {
    const supportedFeatures =
      agent.get(HomeAssistantEntityBehavior).entity.state.attributes
        .supported_features ?? 0;
    if (testBit(supportedFeatures, VacuumDeviceFeature.PAUSE)) {
      return { action: "vacuum.pause" };
    }
    return { action: "vacuum.stop" };
  },
  resume: () => ({
    action: "vacuum.start",
  }),
  goHome: () => ({
    action: "vacuum.return_to_base",
  }),
});
