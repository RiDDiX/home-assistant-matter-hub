import { describe, expect, it } from "vitest";
import {
  percentToPresetIndex,
  toAscendingSpeedPresets,
} from "./fan-mode-order.js";

describe("toAscendingSpeedPresets (#309)", () => {
  it("leaves an already-ascending list unchanged", () => {
    expect(toAscendingSpeedPresets(["low", "medium", "high"])).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(
      toAscendingSpeedPresets(["silent", "low", "medium", "high", "turbo"]),
    ).toEqual(["silent", "low", "medium", "high", "turbo"]);
  });

  it("corrects a descending list to ascending (the #309 SmartIR case)", () => {
    expect(toAscendingSpeedPresets(["high", "mid", "low"])).toEqual([
      "low",
      "mid",
      "high",
    ]);
    expect(
      toAscendingSpeedPresets(["turbo", "high", "medium", "low", "silent"]),
    ).toEqual(["silent", "low", "medium", "high", "turbo"]);
  });

  it("corrects an arbitrary permutation", () => {
    expect(toAscendingSpeedPresets(["high", "low", "mid"])).toEqual([
      "low",
      "mid",
      "high",
    ]);
  });

  it("orders numeric and levelN speeds by value", () => {
    expect(toAscendingSpeedPresets(["3", "2", "1"])).toEqual(["1", "2", "3"]);
    expect(toAscendingSpeedPresets(["level3", "level1", "level2"])).toEqual([
      "level1",
      "level2",
      "level3",
    ]);
  });

  it("returns the list unchanged when any token is not a known speed keyword", () => {
    expect(toAscendingSpeedPresets(["nest", "comfort", "boost"])).toEqual([
      "nest",
      "comfort",
      "boost",
    ]);
  });

  it("is stable for equal-rank tokens and handles edge lists", () => {
    // high and fast share rank 5, original order is preserved
    expect(toAscendingSpeedPresets(["high", "fast"])).toEqual(["high", "fast"]);
    expect(toAscendingSpeedPresets(["high"])).toEqual(["high"]);
    expect(toAscendingSpeedPresets([])).toEqual([]);
  });
});

describe("percentToPresetIndex (#369)", () => {
  it("maps exact band boundaries to the matching preset (4 presets)", () => {
    // Read reports quiet=25, low=50, medium=75, high=100, so the set must
    // invert to the same preset, not the next one up.
    expect(percentToPresetIndex(25, 4)).toBe(0);
    expect(percentToPresetIndex(50, 4)).toBe(1);
    expect(percentToPresetIndex(75, 4)).toBe(2);
    expect(percentToPresetIndex(100, 4)).toBe(3);
  });

  it("keeps within-band percentages on the right preset (4 presets)", () => {
    expect(percentToPresetIndex(1, 4)).toBe(0);
    expect(percentToPresetIndex(24, 4)).toBe(0);
    expect(percentToPresetIndex(26, 4)).toBe(1);
    expect(percentToPresetIndex(49, 4)).toBe(1);
    expect(percentToPresetIndex(51, 4)).toBe(2);
    expect(percentToPresetIndex(99, 4)).toBe(3);
  });

  it("works for other preset counts", () => {
    expect(percentToPresetIndex(33, 3)).toBe(0);
    expect(percentToPresetIndex(34, 3)).toBe(1);
    expect(percentToPresetIndex(66, 3)).toBe(1);
    expect(percentToPresetIndex(67, 3)).toBe(2);
    expect(percentToPresetIndex(100, 3)).toBe(2);
    expect(percentToPresetIndex(50, 2)).toBe(0);
    expect(percentToPresetIndex(51, 2)).toBe(1);
    expect(percentToPresetIndex(100, 2)).toBe(1);
    expect(percentToPresetIndex(1, 1)).toBe(0);
    expect(percentToPresetIndex(100, 1)).toBe(0);
  });

  it("clamps and guards out-of-range input", () => {
    expect(percentToPresetIndex(150, 4)).toBe(3);
    expect(percentToPresetIndex(0, 4)).toBe(0);
    expect(percentToPresetIndex(50, 0)).toBe(0);
  });
});
