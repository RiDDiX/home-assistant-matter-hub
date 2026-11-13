import { describe, expect, it } from "vitest";
import { coverOpenPercent } from "./EndpointCard";

// #495: the chip printed the percent-closed Matter value as "% open".

describe("coverOpenPercent", () => {
  it("shows a closed cover as 0% open", () => {
    expect(coverOpenPercent(10000)).toBe(0);
  });

  it("shows an open cover as 100% open", () => {
    expect(coverOpenPercent(0)).toBe(100);
  });

  it("inverts partial positions", () => {
    expect(coverOpenPercent(2500)).toBe(75);
  });
});
