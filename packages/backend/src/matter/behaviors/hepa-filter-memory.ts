import { Behavior } from "@matter/main";
import { DatatypeModel, FieldElement } from "@matter/main/model";

// HEPA Condition is not persisted, so a start with the filter sensor unknown
// reported a new filter (#505). Kept apart from FanSpeedMemoryBehavior: the
// fan and HEPA reactors run on the same HA change and must not share a lock.
export class HepaFilterMemoryBehavior extends Behavior {
  static override readonly id = "hepaFilterMemory";
  declare state: HepaFilterMemoryBehavior.State;

  static override readonly schema = new DatatypeModel(
    { name: "HepaFilterMemoryState", type: "struct" },
    FieldElement({
      name: "lastCondition",
      type: "uint8",
      quality: "XN",
      default: null,
    }),
  );
}

export namespace HepaFilterMemoryBehavior {
  export class State {
    lastCondition: number | null = null;
  }
}
