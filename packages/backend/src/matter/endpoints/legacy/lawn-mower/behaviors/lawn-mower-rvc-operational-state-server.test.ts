import { RvcOperationalState } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { mapLawnMowerOperationalState } from "./lawn-mower-rvc-operational-state-server.js";

const OS = RvcOperationalState.OperationalState;

describe("mapLawnMowerOperationalState (#301 lawn mower)", () => {
  it("maps the HA lawn_mower activities to RVC operational states", () => {
    expect(mapLawnMowerOperationalState({ state: "mowing" })).toBe(OS.Running);
    expect(mapLawnMowerOperationalState({ state: "returning" })).toBe(
      OS.SeekingCharger,
    );
    expect(mapLawnMowerOperationalState({ state: "docked" })).toBe(OS.Docked);
    expect(mapLawnMowerOperationalState({ state: "paused" })).toBe(OS.Paused);
    expect(mapLawnMowerOperationalState({ state: "error" })).toBe(OS.Error);
    expect(mapLawnMowerOperationalState({ state: "unavailable" })).toBe(
      OS.Error,
    );
  });

  it("treats an unknown state as Stopped", () => {
    expect(mapLawnMowerOperationalState({ state: "weird" })).toBe(OS.Stopped);
  });
});
