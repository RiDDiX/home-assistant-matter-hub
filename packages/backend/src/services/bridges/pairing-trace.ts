import { Logger, LogLevel } from "@matter/general";

const facility = "InteractionServer";

// All bridges share one Logger, so holders are counted across bridges.
let holders = 0;
let previous: LogLevel | string | undefined;

export function acquirePairingTrace(): void {
  if (holders++ > 0) return;
  previous = Logger.facilityLevels[facility];
  Logger.facilityLevels = { [facility]: LogLevel.DEBUG };
}

export function releasePairingTrace(): void {
  if (holders === 0 || --holders > 0) return;
  if (previous !== undefined) {
    Logger.facilityLevels = { [facility]: previous };
    return;
  }
  delete Logger.facilityLevels[facility];
  for (const name in Logger.destinations) {
    delete Logger.destinations[name].facilityLevels?.[facility];
  }
}
