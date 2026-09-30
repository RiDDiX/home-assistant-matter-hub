import { describe, expect, it } from "vitest";
import { formatCoverPosition } from "./EndpointCard";

// #495: the chip printed the percent-closed Matter value as "% open".

describe("formatCoverPosition", () => {
  it("shows a closed cover as 0% open", () => {
    expect(formatCoverPosition(10000)).toBe("0% open");
  });

  it("shows an open cover as 100% open", () => {
    expect(formatCoverPosition(0)).toBe("100% open");
  });

  it("inverts partial positions", () => {
    expect(formatCoverPosition(2500)).toBe("75% open");
  });
});
