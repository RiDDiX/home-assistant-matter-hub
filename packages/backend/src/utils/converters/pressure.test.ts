import { describe, expect, it } from "vitest";
import { convertPressureToHpa } from "./pressure.js";

describe("convertPressureToHpa", () => {
  it("should pass through hPa", () => {
    expect(convertPressureToHpa(1013, "hPa")).toBe(1013);
  });

  it("should pass through mbar (1 mbar = 1 hPa)", () => {
    expect(convertPressureToHpa(1013, "mbar")).toBe(1013);
  });

  it("should convert Pa to hPa", () => {
    expect(convertPressureToHpa(101300, "Pa")).toBe(1013);
  });

  it("should convert kPa to hPa", () => {
    expect(convertPressureToHpa(101.3, "kPa")).toBe(1013);
  });

  it("should convert inHg to hPa", () => {
    const result = convertPressureToHpa(29.92, "inHg");
    expect(result).toBeCloseTo(1013.2, 0);
  });

  it("should convert mmHg to hPa", () => {
    const result = convertPressureToHpa(760, "mmHg");
    expect(result).toBeCloseTo(1013.2, 0);
  });

  it("should be case-insensitive", () => {
    expect(convertPressureToHpa(101300, "PA")).toBe(1013);
    expect(convertPressureToHpa(101.3, "KPA")).toBe(1013);
  });

  it("should assume hPa for unknown units", () => {
    expect(convertPressureToHpa(1013, "unknown")).toBe(1013);
  });

  it("should assume hPa for undefined unit", () => {
    expect(convertPressureToHpa(1013, undefined)).toBe(1013);
  });
});
