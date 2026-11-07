import { describe, expect, it } from "vitest";
import { mappedMilli, toMatterMilli } from "./electrical-unit.js";

describe("toMatterMilli", () => {
  it("scales each supported unit to the Matter milli unit", () => {
    expect(toMatterMilli(1500, "power", "mW")).toBe(1500);
    expect(toMatterMilli(1.5, "power", "W")).toBe(1500);
    expect(toMatterMilli(1.5, "power", "kW")).toBe(1_500_000);
    expect(toMatterMilli(1.5, "power", "MW")).toBe(1_500_000_000);
    expect(toMatterMilli(230, "voltage", "mV")).toBe(230);
    expect(toMatterMilli(230, "voltage", "V")).toBe(230_000);
    expect(toMatterMilli(0.4, "voltage", "kV")).toBe(400_000);
    expect(toMatterMilli(500, "current", "mA")).toBe(500);
    expect(toMatterMilli(0.5, "current", "A")).toBe(500);
    expect(toMatterMilli(750, "energy", "Wh")).toBe(750_000);
    expect(toMatterMilli(7.5, "energy", "kWh")).toBe(7_500_000);
    expect(toMatterMilli(0.5, "energy", "MWh")).toBe(500_000_000);
  });

  it("keeps W, V, A and kWh for a missing, unknown or foreign unit", () => {
    expect(toMatterMilli(42, "power", undefined)).toBe(42_000);
    expect(toMatterMilli(42, "power", "hp")).toBe(42_000);
    expect(toMatterMilli(42, "power", "kWh")).toBe(42_000);
    expect(toMatterMilli(230, "voltage", undefined)).toBe(230_000);
    expect(toMatterMilli(2, "current", "kA")).toBe(2000);
    expect(toMatterMilli(7.5, "energy", undefined)).toBe(7_500_000);
  });
});

describe("mappedMilli", () => {
  const source = (state: string, unit?: string) => ({
    getState: () =>
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      ({ state, attributes: { unit_of_measurement: unit } }) as any,
    getNumericState: () => (Number.isNaN(+state) ? null : +state),
  });

  it("reads the companion's own unit", () => {
    expect(mappedMilli(source("2.5", "kW"), "sensor.p", "power")).toBe(
      2_500_000,
    );
    expect(mappedMilli(source("1200", "Wh"), "sensor.e", "energy")).toBe(
      1_200_000,
    );
  });

  it("returns null without a numeric state", () => {
    expect(mappedMilli(source("unavailable", "W"), "sensor.p", "power")).toBe(
      null,
    );
  });
});
