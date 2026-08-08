import { describe, expect, it } from "vitest";
import { Temperature } from "./temperature.js";

describe("Temperature", () => {
  describe("withUnit", () => {
    it("should return undefined for NaN", () => {
      expect(Temperature.withUnit(NaN, "°C")).toBeUndefined();
    });

    it("should create a Temperature for valid values", () => {
      const t = Temperature.withUnit(25, "°C");
      expect(t).toBeDefined();
      expect(t!.value).toBe(25);
    });
  });

  describe("celsius", () => {
    it("should return celsius from celsius", () => {
      const t = Temperature.celsius(20)!;
      expect(t.celsius()).toBe(20);
    });

    it("should return matter format (value * 100)", () => {
      const t = Temperature.celsius(20.5)!;
      expect(t.celsius(true)).toBe(2050);
    });

    it("should convert fahrenheit to celsius", () => {
      const t = Temperature.fahrenheit(68)!;
      expect(t.celsius()).toBe(20);
    });

    it("should convert kelvin to celsius", () => {
      const t = Temperature.kelvin(293.15)!;
      expect(t.celsius()).toBe(20);
    });
  });

  describe("kelvin", () => {
    it("should convert celsius to kelvin", () => {
      const t = Temperature.celsius(0)!;
      expect(t.kelvin()).toBe(273.15);
    });
  });

  describe("fahrenheit", () => {
    it("should convert celsius to fahrenheit", () => {
      const t = Temperature.celsius(100)!;
      expect(t.fahrenheit()).toBe(212);
    });
  });

  describe("toUnit", () => {
    it("should return same value for same unit", () => {
      const t = Temperature.celsius(25)!;
      expect(t.toUnit("°C")).toBe(25);
    });
  });

  describe("plus", () => {
    it("should add temperatures in the same unit", () => {
      const t = Temperature.celsius(20)!;
      const result = t.plus(5, "°C");
      expect(result.celsius()).toBe(25);
    });

    it("should add temperatures in different units", () => {
      const t = Temperature.celsius(0)!;
      const result = t.plus(32, "°F");
      expect(result.celsius()).toBe(0);
    });
  });

  describe("equals", () => {
    it("should return true for equal temperatures", () => {
      const a = Temperature.celsius(100)!;
      const b = Temperature.fahrenheit(212)!;
      expect(a.equals(b)).toBe(true);
    });

    it("should return false for different temperatures", () => {
      const a = Temperature.celsius(100)!;
      const b = Temperature.celsius(99)!;
      expect(a.equals(b)).toBe(false);
    });

    it("should return false for undefined", () => {
      const a = Temperature.celsius(100)!;
      expect(a.equals(undefined)).toBe(false);
    });
  });
});
