import { VacuumState } from "@home-assistant-matter-hub/common";
import { PowerSource } from "@matter/main/clusters";
import { PowerSourceServer } from "../../../../behaviors/power-source-server.js";
import {
  getVacuumBatteryPercent,
  getVacuumChargingState,
} from "./vacuum-battery.js";

export const VacuumPowerSourceServer = PowerSourceServer({
  getBatteryPercent: getVacuumBatteryPercent,
  isCharging(entity) {
    const state = entity.state as VacuumState | "unavailable";
    // Vacuum is typically charging when docked
    return state === VacuumState.docked;
  },
  getChargeState(_, agent) {
    const signal = getVacuumChargingState(agent);
    if (signal === "charging") return PowerSource.BatChargeState.IsCharging;
    if (signal === "full") return PowerSource.BatChargeState.IsAtFullCharge;
    if (signal === "not_charging")
      return PowerSource.BatChargeState.IsNotCharging;
    return null;
  },
});
