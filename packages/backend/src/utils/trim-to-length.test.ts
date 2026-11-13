import { describe, expect, it } from "vitest";
import { trimToLength } from "./trim-to-length.js";

const bytes = (s?: string) => Buffer.byteLength(s ?? "");

describe("trimToLength", () => {
  it("cuts ASCII as before", () => {
    expect(trimToLength("Wohnzimmer Deckenlampe links hinten", 32, "...")).toBe(
      "Wohnzimmer Deckenlampe links ...",
    );
    expect(trimToLength("Kitchen", 32, "...")).toBe("Kitchen");
    expect(trimToLength("  ", 32, "...")).toBeUndefined();
  });

  it("keeps CJK names within the byte limit (#518)", () => {
    const name = "客厅空调伴侣 插座 电量 统计 传感器 小米";
    const trimmed = trimToLength(name, 32, "...");
    expect(bytes(trimmed)).toBeLessThanOrEqual(32);
    expect(trimmed).toBe("客厅空调伴侣 插座 电...");
    expect(trimToLength("客厅吸顶灯", 32, "...")).toBe("客厅吸顶灯");
  });

  it("cuts room labels to 16 bytes without a suffix", () => {
    expect(trimToLength("主卧室卫生间", 16, "")).toBe("主卧室卫生");
    expect(trimToLength("Living room", 16, "")).toBe("Living room");
  });

  it.each([
    ["Kitchen light", 2, "...", "Ki"],
    ["客厅吸顶灯", 4, ".....", "客"],
    ["light.kitchen", 3, "abcd", "lig"],
    ["light.kitchen", 0, "...", ""],
    ["light.kitchen", -4, "...", ""],
  ])("cuts %s to %i bytes when suffix %s does not fit", (value, max, suffix, expected) => {
    const trimmed = trimToLength(value, max, suffix);
    expect(trimmed).toBe(expected);
    expect(bytes(trimmed)).toBeLessThanOrEqual(Math.max(max, 0));
  });

  it("never splits a surrogate pair", () => {
    const trimmed = trimToLength("💡".repeat(20), 64, "...");
    expect(bytes(trimmed)).toBeLessThanOrEqual(64);
    expect(trimmed).toBe(`${"💡".repeat(15)}...`);
  });
});
