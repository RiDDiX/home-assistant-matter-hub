import { OnOffServer } from "../../../../behaviors/on-off-server.js";
import { vacuumIsCleaning } from "./vacuum-rvc-run-mode-server.js";

export const VacuumOnOffServer = OnOffServer({
  // Derive from the entity directly. Reading the sibling rvcRunMode behavior
  // crashed with a class mismatch and would lag one tick behind anyway (#428).
  isOn: (entity) => vacuumIsCleaning(entity.state),
  turnOn: () => ({ action: "vacuum.start" }),
  turnOff: () => ({ action: "vacuum.return_to_base" }),
}).with();
