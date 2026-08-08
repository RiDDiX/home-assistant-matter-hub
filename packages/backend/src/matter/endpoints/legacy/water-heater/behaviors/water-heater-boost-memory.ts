import { Behavior } from "@matter/main";
import { DatatypeModel, FieldElement } from "@matter/main/model";

// A running Boost lives in a module WeakMap and dies with the process, which
// would strand HA in high_demand across a bridge restart. Quality N behavior
// state survives restarts (the FanSpeedMemoryBehavior precedent), so the
// restore data is mirrored here and picked up again at initialize.
export class WaterHeaterBoostMemoryBehavior extends Behavior {
  static override readonly id = "waterHeaterBoostMemory";
  declare state: WaterHeaterBoostMemoryBehavior.State;

  static override readonly schema = new DatatypeModel(
    { name: "WaterHeaterBoostMemoryState", type: "struct" },
    FieldElement({
      name: "active",
      type: "bool",
      quality: "N",
      default: false,
    }),
    // Empty string when there is no mode to restore.
    FieldElement({
      name: "previousOperationMode",
      type: "string",
      quality: "N",
      default: "",
    }),
    FieldElement({
      name: "hasRestoreTemperature",
      type: "bool",
      quality: "N",
      default: false,
    }),
    // HA units, valid only while hasRestoreTemperature is set.
    FieldElement({
      name: "restoreTemperature",
      type: "double",
      quality: "N",
      default: 0,
    }),
    // Epoch milliseconds, 0 for a boost without an expiry.
    FieldElement({
      name: "expiresAt",
      type: "double",
      quality: "N",
      default: 0,
    }),
    FieldElement({
      name: "oneShot",
      type: "bool",
      quality: "N",
      default: false,
    }),
  );
}

export namespace WaterHeaterBoostMemoryBehavior {
  export class State {
    active = false;
    previousOperationMode = "";
    hasRestoreTemperature = false;
    restoreTemperature = 0;
    expiresAt = 0;
    oneShot = false;
  }
}
