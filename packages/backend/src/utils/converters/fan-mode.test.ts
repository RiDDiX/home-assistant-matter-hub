import { FanControl } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { autoPresetName, FanMode } from "./fan-mode.js";

import MFanMode = FanControl.FanMode;
import FanModeSequence = FanControl.FanModeSequence;

describe("FanMode", () => {
  describe("speedPercent", () => {
    it.each([
      [MFanMode.Off, FanModeSequence.OffLowMedHighAuto, 0],
      [MFanMode.Low, FanModeSequence.OffLowMedHighAuto, (1 / 3) * 100],
      [MFanMode.Medium, FanModeSequence.OffLowMedHighAuto, (2 / 3) * 100],
      [MFanMode.High, FanModeSequence.OffLowMedHighAuto, 100],
      [MFanMode.Low, FanModeSequence.OffLowHigh, 50],
      [MFanMode.Medium, FanModeSequence.OffLowHigh, 50],
      [MFanMode.High, FanModeSequence.OffLowHigh, 100],
    ])("should determine the correct speed (%s & %s)", (mode, sequence, expected) => {
      expect(FanMode.create(mode, sequence).speedPercent()).toEqual(expected);
    });
  });

  describe("fromSpeedPercent", () => {
    it.each([
      [0, MFanMode.Off],
      [1, MFanMode.Low],
      [12, MFanMode.Low],
      [33, MFanMode.Low],
      [34, MFanMode.Medium],
      [40, MFanMode.Medium],
      [50, MFanMode.Medium],
      [66, MFanMode.Medium],
      [67, MFanMode.High],
      [75, MFanMode.High],
      [90, MFanMode.High],
      [100, MFanMode.High],
    ])("should return correct mode for sequence (%s -> %s)", (percentage, expected) => {
      expect(
        FanMode.fromSpeedPercent(percentage, FanModeSequence.OffLowMedHighAuto)
          .mode,
      ).toEqual(expected);
    });
  });
});

describe("autoPresetName", () => {
  it("finds the auto preset case-insensitively", () => {
    expect(autoPresetName(["low", "AUTO", "high"])).toBe("AUTO");
    expect(autoPresetName(["auto"])).toBe("auto");
  });

  it("does not match substrings like Auto Comfort or Automatic", () => {
    // A preset like "Automatic" cannot be commanded by sending "auto", so it
    // must not count as Auto support.
    expect(autoPresetName(["Auto Comfort", "Automatic"])).toBeUndefined();
  });

  it("handles empty and missing lists", () => {
    expect(autoPresetName([])).toBeUndefined();
    expect(autoPresetName(undefined)).toBeUndefined();
  });
});
