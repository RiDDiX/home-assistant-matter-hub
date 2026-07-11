import { Behavior } from "@matter/main";
import { DatatypeModel, FieldElement } from "@matter/main/model";

// Remembers the last non-zero fan speed (#387). matter.js creates behavior
// instances per transaction, so instance fields on the fan server reset on
// every interaction and the power-on restore never saw the captured speed.
// Behavior state survives transactions, and quality N persists it across
// restarts too.
export class FanSpeedMemoryBehavior extends Behavior {
  static override readonly id = "fanSpeedMemory";
  declare state: FanSpeedMemoryBehavior.State;

  static override readonly schema = new DatatypeModel(
    { name: "FanSpeedMemoryState", type: "struct" },
    FieldElement({
      name: "lastPercent",
      type: "uint8",
      quality: "N",
      default: 0,
    }),
    FieldElement({
      name: "lastSpeed",
      type: "uint8",
      quality: "N",
      default: 0,
    }),
    FieldElement({
      name: "lastAuto",
      type: "bool",
      quality: "N",
      default: false,
    }),
  );
}

export namespace FanSpeedMemoryBehavior {
  export class State {
    lastPercent = 0;
    lastSpeed = 0;
    lastAuto = false;
  }
}
