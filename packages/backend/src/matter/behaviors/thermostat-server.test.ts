import { describe, expect, it } from "vitest";
import {
  repairSetpointLimits,
  thermostatPreInitialize,
} from "./thermostat-server.js";

describe("repairSetpointLimits (#375)", () => {
  it("lowers a drifted absMin so absMin <= min", () => {
    expect(
      repairSetpointLimits({
        absMin: 6100,
        min: 1611,
        max: 3000,
        absMax: 3000,
      }),
    ).toEqual({ absMin: 1611, min: 1611, max: 3000, absMax: 3000 });
  });

  it("raises a drifted absMax so max <= absMax", () => {
    expect(
      repairSetpointLimits({ absMin: 0, min: 1600, max: 3000, absMax: 2000 }),
    ).toEqual({ absMin: 0, min: 1600, max: 3000, absMax: 3000 });
  });

  it("orders inverted regular limits", () => {
    expect(
      repairSetpointLimits({ absMin: 0, min: 3000, max: 1600, absMax: 5000 }),
    ).toEqual({ absMin: 0, min: 1600, max: 3000, absMax: 5000 });
  });

  it("keeps sub-zero limits (no clamp to 0)", () => {
    expect(
      repairSetpointLimits({ absMin: 0, min: -1800, max: 500, absMax: 500 }),
    ).toEqual({ absMin: -1800, min: -1800, max: 500, absMax: 500 });
  });

  it("leaves a valid set unchanged", () => {
    expect(
      repairSetpointLimits({ absMin: 700, min: 1600, max: 3000, absMax: 3200 }),
    ).toEqual({ absMin: 700, min: 1600, max: 3000, absMax: 3200 });
  });
});

describe("thermostatPreInitialize recovers a stuck device (#375)", () => {
  it("repairs a persisted absMin 6100 > min 1611 before validation", () => {
    const self = {
      features: { heating: true, cooling: true, autoMode: false },
      // The values matter.js loads from a stuck device: min converted (1611)
      // but absMin left in the old raw Fahrenheit form (6100).
      state: {
        localTemperature: 2100,
        absMinHeatSetpointLimit: 6100,
        minHeatSetpointLimit: 1611,
        maxHeatSetpointLimit: 3000,
        absMaxHeatSetpointLimit: 3000,
        occupiedHeatingSetpoint: 2000,
        absMinCoolSetpointLimit: 6100,
        minCoolSetpointLimit: 1611,
        maxCoolSetpointLimit: 3000,
        absMaxCoolSetpointLimit: 3000,
        occupiedCoolingSetpoint: 2400,
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock of the behavior self
    thermostatPreInitialize(self as any);
    const s = self.state;
    expect(s.absMinHeatSetpointLimit).toBeLessThanOrEqual(
      s.minHeatSetpointLimit,
    );
    expect(s.minHeatSetpointLimit).toBeLessThanOrEqual(s.maxHeatSetpointLimit);
    expect(s.maxHeatSetpointLimit).toBeLessThanOrEqual(
      s.absMaxHeatSetpointLimit,
    );
    expect(s.absMinCoolSetpointLimit).toBeLessThanOrEqual(
      s.minCoolSetpointLimit,
    );
    // the drifted 6100 is gone, replaced by the valid converted value
    expect(s.absMinHeatSetpointLimit).toBe(1611);
  });
});
