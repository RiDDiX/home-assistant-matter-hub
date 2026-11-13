import { RvcOperationalState } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { mapVacuumOperationalError } from "./vacuum-operational-error.js";

const { ErrorState } = RvcOperationalState;

describe("Roborock operational errors", () => {
  it.each([
    ["lidar_blocked", 78],
    ["bumper_stuck", 65],
    ["wheels_suspended", 65],
    ["cliff_sensor_error", 78],
    ["main_brush_jammed", 77],
    ["side_brush_jammed", 77],
    ["wheels_jammed", 76],
    ["robot_trapped", 65],
    ["no_dustbin", 66],
    ["strainer_error", 2],
    ["compass_error", 2],
    ["low_battery", 72],
    ["charging_error", 2],
    ["battery_error", 2],
    ["wall_sensor_dirty", 78],
    ["robot_tilted", 65],
    ["side_brush_error", 2],
    ["fan_error", 2],
    ["dock", 2],
    ["optical_flow_sensor_dirt", 78],
    ["vertical_bumper_pressed", 65],
    ["dock_locator_error", 2],
    ["return_to_dock_fail", 64],
    ["nogo_zone_detected", 65],
    ["visual_sensor", 78],
    ["light_touch", 65],
    ["vibrarise_jammed", 2],
    ["robot_on_carpet", 65],
    ["filter_blocked", 2],
    ["invisible_wall_detected", 65],
    ["cannot_cross_carpet", 65],
    ["internal_error", 2],
    ["collect_dust_error_3", 2],
    ["collect_dust_error_4", 2],
    ["mopping_roller_1", 2],
    ["mopping_roller_error_2", 2],
    ["clear_water_box_hoare", 2],
    ["dirty_water_box_hoare", 2],
    ["sink_strainer_hoare", 2],
    ["clear_water_box_exception", 68],
    ["clear_brush_exception", 2],
    ["clear_brush_exception_2", 2],
    ["filter_screen_exception", 2],
    ["mopping_roller_2", 2],
    ["up_water_exception", 2],
    ["drain_water_exception", 2],
    ["temperature_protection", 2],
    ["clean_carousel_exception", 2],
    ["clean_carousel_water_full", 2],
    ["water_carriage_drop", 2],
    ["check_clean_carouse", 2],
    ["audio_error", 2],
  ])("maps %s to its standard RVC error", (fault, id) => {
    const result = mapVacuumOperationalError("error", String(fault), true);
    expect(result.errorStateId).toBe(id);
    expect(result.errorStateDetails).toContain(`[${fault}]`);
    expect(result).not.toHaveProperty("errorStateLabel");
    expect(Buffer.byteLength(result.errorStateLabel ?? "")).toBeLessThanOrEqual(
      64,
    );
    expect(
      Buffer.byteLength(result.errorStateDetails ?? ""),
    ).toBeLessThanOrEqual(64);
  });

  it.each([
    "returning",
    "cleaning",
    "docked",
    "idle",
    "paused",
    "unknown",
    "unavailable",
  ])("does not invent a fault while %s even with a stale sensor", (state) =>
    expect(mapVacuumOperationalError(state, "low_battery", true)).toEqual({
      errorStateId: ErrorState.NoError,
    }));

  it.each([
    undefined,
    "unknown",
    "unavailable",
    "none",
    "unrecognized",
    "__proto__",
    "constructor",
    "x".repeat(200),
  ])("falls back safely for unknown sensor value %s", (fault) =>
    expect(mapVacuumOperationalError("error", fault, true)).toEqual({
      errorStateId: ErrorState.UnableToCompleteOperation,
      errorStateDetails: "Vacuum operational error",
    }));

  it("preserves the previous genuine-error fallback for unmapped vacuums", () => {
    expect(mapVacuumOperationalError("error")).toEqual({
      errorStateId: ErrorState.Stuck,
      errorStateDetails: "Stuck",
    });
  });
});
