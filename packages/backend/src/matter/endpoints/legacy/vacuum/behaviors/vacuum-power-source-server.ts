import {
  type VacuumDeviceAttributes,
  VacuumState,
} from "@home-assistant-matter-hub/common";
import { PowerSourceServer } from "../../../../behaviors/power-source-server.js";

export const VacuumPowerSourceServer = PowerSourceServer({
  getBatteryPercent(entity) {
    const attributes = entity.attributes as VacuumDeviceAttributes;
    // Some vacuums use 'battery_level', others use 'battery' (e.g. Dreame)
    const batteryLevel = attributes.battery_level ?? attributes.battery;
    if (batteryLevel == null || typeof batteryLevel !== "number") {
      return null;
    }
    return batteryLevel;
  },
  isCharging(entity) {
    const state = entity.state as VacuumState | "unavailable";
    // Vacuum is typically charging when docked
    return state === VacuumState.docked;
  },
});
