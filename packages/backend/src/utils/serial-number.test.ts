import { describe, expect, it } from "vitest";
import { serialNumberWithSuffix } from "./serial-number.js";
import { trimToLength } from "./trim-to-length.js";

const bytes = (s?: string) => Buffer.byteLength(s ?? "");
const ellipse = (value: string) => (max: number) =>
  trimToLength(value, max, "...");

describe("serialNumberWithSuffix", () => {
  it("keeps a CJK suffix within 32 bytes", () => {
    const suffix = "客厅空调伴侣插座电量统计";
    const serial = serialNumberWithSuffix(suffix, ellipse("ABCDEFGH12345678"));
    expect(bytes(serial)).toBeLessThanOrEqual(32);
    expect(Buffer.from(serial ?? "").toString()).toBe(serial);
    expect(serial).not.toContain("�");
    expect(serial).toBe("AB客厅空调伴侣插座电量");
  });

  it("matches the plain append when the suffix fits", () => {
    expect(serialNumberWithSuffix(undefined, ellipse("ABC"))).toBe("ABC");
    expect(serialNumberWithSuffix("", ellipse("ABC"))).toBe("ABC");
    expect(serialNumberWithSuffix("-v2", ellipse("ABC"))).toBe("ABC-v2");
    expect(serialNumberWithSuffix("-v2", ellipse("x".repeat(40)))).toBe(
      `${"x".repeat(26)}...-v2`,
    );
    expect(serialNumberWithSuffix("新", ellipse("客".repeat(12)))).toBe(
      `${"客".repeat(8)}...新`,
    );
    expect(serialNumberWithSuffix("-v2", () => undefined)).toBeUndefined();
  });

  it("returns the suffix alone when it fills all 32 bytes", () => {
    const suffix = "s".repeat(32);
    expect(serialNumberWithSuffix(suffix, ellipse("ABC"))).toBe(suffix);
  });
});
