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
  getChargeState(entity, agent) {
    const signal = getVacuumChargingState(agent);
    if (signal === "charging") return PowerSource.BatChargeState.IsCharging;
    if (signal === "full") return PowerSource.BatChargeState.IsAtFullCharge;
    if (signal === "not_charging") {
      // A plain charging sensor only says on or off, so a robot that finished
      // on its dock would drop from full to not charging (#206).
      const percent = getVacuumBatteryPercent(entity, agent);
      return percent != null && percent >= 100
        ? PowerSource.BatChargeState.IsAtFullCharge
        : PowerSource.BatChargeState.IsNotCharging;
    }
    return null;
  },
});
