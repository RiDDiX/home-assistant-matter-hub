import type { BridgeFeatureFlags } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { adjustPosition } from "./cover-position-utils.js";

describe("adjustPosition", () => {
  it("inverts by default (no flags)", () => {
    expect(adjustPosition(80, undefined)).toBe(20);
    expect(adjustPosition(20, undefined)).toBe(80);
    expect(adjustPosition(0, undefined)).toBe(100);
    expect(adjustPosition(100, undefined)).toBe(0);
    expect(adjustPosition(50, undefined)).toBe(50);
  });

  it("inverts with empty flags", () => {
    expect(adjustPosition(80, {})).toBe(20);
  });

  it("skips inversion with coverDoNotInvertPercentage", () => {
    const flags: BridgeFeatureFlags = { coverDoNotInvertPercentage: true };
    expect(adjustPosition(80, flags)).toBe(80);
    expect(adjustPosition(0, flags)).toBe(0);
    expect(adjustPosition(100, flags)).toBe(100);
  });

  it("skips inversion with coverUseHomeAssistantPercentage", () => {
    const flags: BridgeFeatureFlags = {
      coverUseHomeAssistantPercentage: true,
    };
    expect(adjustPosition(80, flags)).toBe(80);
    expect(adjustPosition(20, flags)).toBe(20);
    expect(adjustPosition(0, flags)).toBe(0);
  });

  it("coverSwapOpenClose skips inversion (position passes through)", () => {
    const flags: BridgeFeatureFlags = { coverSwapOpenClose: true };
    expect(adjustPosition(80, flags)).toBe(80);
    expect(adjustPosition(20, flags)).toBe(20);
    expect(adjustPosition(0, flags)).toBe(0);
    expect(adjustPosition(100, flags)).toBe(100);
  });

  it("coverUseHomeAssistantPercentage takes precedence over coverSwapOpenClose (#148)", () => {
    const flags: BridgeFeatureFlags = {
      coverSwapOpenClose: true,
      coverUseHomeAssistantPercentage: true,
    };
    expect(adjustPosition(80, flags)).toBe(80);
    expect(adjustPosition(0, flags)).toBe(0);
    expect(adjustPosition(100, flags)).toBe(100);
  });

  it("coverDoNotInvertPercentage takes precedence over coverSwapOpenClose", () => {
    const flags: BridgeFeatureFlags = {
      coverSwapOpenClose: true,
      coverDoNotInvertPercentage: true,
    };
    expect(adjustPosition(80, flags)).toBe(80);
  });

  it("is its own inverse, so reading and writing round-trip", () => {
    const flagCombos: (BridgeFeatureFlags | undefined)[] = [
      undefined,
      {},
      { coverSwapOpenClose: true },
      { coverUseHomeAssistantPercentage: true },
      { coverDoNotInvertPercentage: true },
      { coverSwapOpenClose: true, coverUseHomeAssistantPercentage: true },
    ];

    for (const flags of flagCombos) {
      for (let pos = 0; pos <= 100; pos += 25) {
        expect(adjustPosition(adjustPosition(pos, flags), flags)).toBe(pos);
      }
    }
  });
});
