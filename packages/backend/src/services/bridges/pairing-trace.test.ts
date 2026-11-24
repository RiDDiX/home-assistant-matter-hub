import { LogDestination, Logger, LogLevel } from "@matter/general";
import { afterEach, describe, expect, it } from "vitest";
import { acquirePairingTrace, releasePairingTrace } from "./pairing-trace.js";

const facility = "InteractionServer";

describe("pairing trace", () => {
  afterEach(() => {
    delete Logger.destinations.extra;
    delete Logger.facilityLevels[facility];
    for (const name in Logger.destinations) {
      delete Logger.destinations[name].facilityLevels[facility];
    }
  });

  it("debug stays on until the last holder releases", () => {
    acquirePairingTrace();
    acquirePairingTrace();
    expect(Logger.facilityLevels[facility]).toBe(LogLevel.DEBUG);
    releasePairingTrace();
    expect(Logger.facilityLevels[facility]).toBe(LogLevel.DEBUG);
    releasePairingTrace();
    expect(Logger.facilityLevels[facility]).toBeUndefined();
  });

  it("puts an explicit previous level back", () => {
    Logger.facilityLevels = { [facility]: LogLevel.WARN };
    acquirePairingTrace();
    expect(Logger.facilityLevels[facility]).toBe(LogLevel.DEBUG);
    releasePairingTrace();
    expect(Logger.facilityLevels[facility]).toBe(LogLevel.WARN);
  });

  it("removes the key from the defaults and every destination", () => {
    Logger.destinations.extra = LogDestination({
      name: "extra",
      facilityLevels: {},
    });
    acquirePairingTrace();
    expect(Logger.destinations.extra.facilityLevels[facility]).toBe(
      LogLevel.DEBUG,
    );
    releasePairingTrace();
    expect(facility in Logger.facilityLevels).toBe(false);
    for (const name in Logger.destinations) {
      expect(facility in Logger.destinations[name].facilityLevels).toBe(false);
    }
  });

  it("an extra release does not go negative", () => {
    releasePairingTrace();
    acquirePairingTrace();
    expect(Logger.facilityLevels[facility]).toBe(LogLevel.DEBUG);
    releasePairingTrace();
    expect(Logger.facilityLevels[facility]).toBeUndefined();
  });
});
