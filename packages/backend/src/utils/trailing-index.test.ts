import { describe, expect, it } from "vitest";
import { trailingIndex } from "./trailing-index.js";

describe("trailingIndex", () => {
  it("returns the trailing integer", () => {
    expect(trailingIndex("switch.strip_switch_2")).toBe(2);
    expect(trailingIndex("sensor.strip_power_2")).toBe(2);
  });

  it("takes the last number when several are present", () => {
    expect(trailingIndex("sensor.power_strip_4_power_3")).toBe(3);
  });

  it("returns undefined without a trailing number", () => {
    expect(trailingIndex("sensor.strip_power")).toBeUndefined();
    expect(trailingIndex("switch.kitchen_top")).toBeUndefined();
  });
});
