import { describe, expect, it } from "vitest";
import { isCoverPositionInverted } from "./bridge-data.js";

describe("isCoverPositionInverted", () => {
  it("inverts without flags", () => {
    expect(isCoverPositionInverted()).toBe(true);
    expect(isCoverPositionInverted({})).toBe(true);
  });

  // doNotInvert, useHomeAssistant, swap => inverted
  it.each([
    [false, false, false, true],
    [true, false, false, false],
    [false, true, false, false],
    [false, false, true, false],
    [true, true, false, false],
    [true, false, true, false],
    [false, true, true, false],
    [true, true, true, false],
  ])("doNotInvert=%s useHa=%s swap=%s => %s", (doNotInvert, useHa, swap, inverted) => {
    expect(
      isCoverPositionInverted({
        coverDoNotInvertPercentage: doNotInvert,
        coverUseHomeAssistantPercentage: useHa,
        coverSwapOpenClose: swap,
      }),
    ).toBe(inverted);
  });
});
