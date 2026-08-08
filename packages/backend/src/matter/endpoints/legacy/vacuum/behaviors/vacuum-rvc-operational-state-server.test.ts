import { RvcOperationalState } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { mapVacuumOperationalState } from "./vacuum-rvc-operational-state-server.js";

const { OperationalState } = RvcOperationalState;

describe("mapVacuumOperationalState", () => {
  it("returns Docked when docked at 100% with explicit charging=false (#334)", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: {
          charging: false,
          battery_level: 100,
          battery_icon: "mdi:battery-charging-100",
          status: "Charging complete",
        },
      }),
    ).toBe(OperationalState.Docked);
  });

  it("returns Docked when docked at 100% with no explicit charging signal", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: {
          battery_level: 100,
          battery_icon: "mdi:battery-charging-100",
        },
      }),
    ).toBe(OperationalState.Docked);
  });

  it("returns Charging when docked at <100% with explicit charging=true", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: { charging: true, battery_level: 75 },
      }),
    ).toBe(OperationalState.Charging);
  });

  it("returns Charging when docked at <100% via battery_icon heuristic", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: {
          battery_level: 60,
          battery_icon: "mdi:battery-charging-60",
        },
      }),
    ).toBe(OperationalState.Charging);
  });

  it("returns Charging when docked below full, matching batChargeState (#377)", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: { battery_level: 80 },
      }),
    ).toBe(OperationalState.Charging);
  });

  it("charging-state signal overrides the battery inference (#377)", () => {
    // docked at 80% would infer Charging, but the dedicated sensor says it is
    // done, so it stays Docked.
    expect(
      mapVacuumOperationalState(
        { state: "docked", attributes: { battery_level: 80 } },
        80,
        "not_charging",
      ),
    ).toBe(OperationalState.Docked);
    expect(
      mapVacuumOperationalState(
        { state: "docked", attributes: {} },
        100,
        "charging",
      ),
    ).toBe(OperationalState.Charging);
    expect(
      mapVacuumOperationalState(
        { state: "idle", attributes: {} },
        50,
        "charging",
      ),
    ).toBe(OperationalState.Charging);
  });

  it("uses the mapped battery percent passed in: <100 Charging (#377)", () => {
    expect(
      mapVacuumOperationalState({ state: "docked", attributes: {} }, 80),
    ).toBe(OperationalState.Charging);
  });

  it("uses the mapped battery percent passed in: 100 Docked (#377)", () => {
    expect(
      mapVacuumOperationalState({ state: "docked", attributes: {} }, 100),
    ).toBe(OperationalState.Docked);
  });

  it("respects explicit charging=false even below full (#377)", () => {
    expect(
      mapVacuumOperationalState(
        { state: "docked", attributes: { charging: false } },
        80,
      ),
    ).toBe(OperationalState.Docked);
  });

  it("returns Running for cleaning states", () => {
    for (const state of [
      "cleaning",
      "segment_cleaning",
      "zone_cleaning",
      "spot_cleaning",
      "mop_cleaning",
    ]) {
      expect(mapVacuumOperationalState({ state, attributes: {} })).toBe(
        OperationalState.Running,
      );
    }
  });

  it("returns SeekingCharger when returning", () => {
    expect(
      mapVacuumOperationalState({ state: "returning", attributes: {} }),
    ).toBe(OperationalState.SeekingCharger);
  });

  it("returns Paused when paused", () => {
    expect(mapVacuumOperationalState({ state: "paused", attributes: {} })).toBe(
      OperationalState.Paused,
    );
  });

  it("returns Charging for idle when charging attribute is true", () => {
    expect(
      mapVacuumOperationalState({
        state: "idle",
        attributes: { is_charging: true, battery_level: 50 },
      }),
    ).toBe(OperationalState.Charging);
  });

  it("returns Stopped for idle when not charging", () => {
    expect(
      mapVacuumOperationalState({
        state: "idle",
        attributes: { battery_level: 90 },
      }),
    ).toBe(OperationalState.Stopped);
  });

  it("returns Error for error/unavailable", () => {
    expect(mapVacuumOperationalState({ state: "error", attributes: {} })).toBe(
      OperationalState.Error,
    );
    expect(
      mapVacuumOperationalState({ state: "unavailable", attributes: {} }),
    ).toBe(OperationalState.Error);
  });

  it("handles string battery_level like '100%'", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: {
          battery_level: "100%",
          battery_icon: "mdi:battery-charging-100",
        },
      }),
    ).toBe(OperationalState.Docked);
  });

  it("uses 'battery' attribute fallback for Dreame-style vacuums", () => {
    expect(
      mapVacuumOperationalState({
        state: "docked",
        attributes: {
          battery: 100,
          battery_icon: "mdi:battery-charging-100",
        },
      }),
    ).toBe(OperationalState.Docked);
  });
});
