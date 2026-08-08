import { FanControl } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { fanModeSequenceFor } from "./fan-mode.js";

describe("fanModeSequenceFor", () => {
  it("uses OffLowHigh for a two-speed entity", () => {
    // A climate with fan_modes ["low","high"] must not advertise a Medium the
    // entity would reject.
    expect(fanModeSequenceFor(2, false)).toBe(
      FanControl.FanModeSequence.OffLowHigh,
    );
    expect(fanModeSequenceFor(2, true)).toBe(
      FanControl.FanModeSequence.OffLowHighAuto,
    );
  });

  it("uses OffHigh for a single-speed entity", () => {
    expect(fanModeSequenceFor(1, false)).toBe(
      FanControl.FanModeSequence.OffHigh,
    );
    expect(fanModeSequenceFor(1, true)).toBe(
      FanControl.FanModeSequence.OffHighAuto,
    );
  });

  it("keeps OffLowMedHigh for three or more speeds", () => {
    expect(fanModeSequenceFor(3, false)).toBe(
      FanControl.FanModeSequence.OffLowMedHigh,
    );
    expect(fanModeSequenceFor(7, true)).toBe(
      FanControl.FanModeSequence.OffLowMedHighAuto,
    );
  });

  it("falls back to the full sequence when the count is unknown", () => {
    expect(fanModeSequenceFor(undefined, false)).toBe(
      FanControl.FanModeSequence.OffLowMedHigh,
    );
    expect(fanModeSequenceFor(undefined, true)).toBe(
      FanControl.FanModeSequence.OffLowMedHighAuto,
    );
  });
});
