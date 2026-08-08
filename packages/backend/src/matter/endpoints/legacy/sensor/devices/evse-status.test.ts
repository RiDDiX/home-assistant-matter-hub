import { EnergyEvse } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { mapEvseStatus } from "./evse-status.js";

const S = EnergyEvse.State;
const Supply = EnergyEvse.SupplyState;
const Fault = EnergyEvse.FaultState;

describe("mapEvseStatus", () => {
  it.each([
    ["charging", S.PluggedInCharging, Supply.ChargingEnabled, Fault.NoError],
    ["Charging", S.PluggedInCharging, Supply.ChargingEnabled, Fault.NoError],
    ["error", S.Fault, Supply.DisabledError, Fault.Other],
    ["fault", S.Fault, Supply.DisabledError, Fault.Other],
  ])("maps %s (switch off)", (raw, state, supply, fault) => {
    const result = mapEvseStatus(raw, false);
    expect(result.state).toBe(state);
    expect(result.supplyState).toBe(supply);
    expect(result.faultState).toBe(fault);
  });

  it("excludes discharging from the charging branch", () => {
    // "discharging" contains "charg" but must not map to PluggedInCharging.
    const result = mapEvseStatus("discharging", false);
    expect(result.state).not.toBe(S.PluggedInCharging);
    // falls through to the unmatched passthrough
    expect(result.state).toBeNull();
    expect(result.supplyState).toBe(Supply.Disabled);
  });

  it.each([
    ["not charging"],
    ["not_charging"],
    ["not-charging"],
  ])("maps %s to PluggedInNoDemand, not PluggedInCharging", (raw) => {
    // "not charging" contains "charg" but the vehicle is plugged in and idle,
    // so it belongs in the switch-dependent no-demand branch.
    const result = mapEvseStatus(raw, false);
    expect(result.state).toBe(S.PluggedInNoDemand);
    expect(result.state).not.toBe(S.PluggedInCharging);
    // switch off -> Disabled supply
    expect(result.supplyState).toBe(Supply.Disabled);
  });

  it("ties negated-charging supply to the charging switch", () => {
    expect(mapEvseStatus("not charging", true).supplyState).toBe(
      Supply.ChargingEnabled,
    );
  });

  it("checks 'not connected' before plain 'connected'", () => {
    const result = mapEvseStatus("not connected", false);
    expect(result.state).toBe(S.NotPluggedIn);
  });

  it.each([
    ["disconnected"],
    ["not_connected"],
    ["no vehicle"],
  ])("maps %s to NotPluggedIn", (raw) => {
    expect(mapEvseStatus(raw, false).state).toBe(S.NotPluggedIn);
  });

  it("maps a plugged-in idle status to PluggedInNoDemand", () => {
    for (const raw of [
      "connected",
      "ready",
      "awaiting start",
      "completed",
      "sleeping",
      "paused",
    ]) {
      expect(mapEvseStatus(raw, false).state).toBe(S.PluggedInNoDemand);
    }
  });

  it("ties the idle supplyState to the charging switch", () => {
    expect(mapEvseStatus("connected", true).supplyState).toBe(
      Supply.ChargingEnabled,
    );
    expect(mapEvseStatus("connected", false).supplyState).toBe(Supply.Disabled);
  });

  it.each([
    ["unknown"],
    ["unavailable"],
    [""],
    ["something weird"],
  ])("passes through %s with a null state and disabled supply", (raw) => {
    const result = mapEvseStatus(raw, false);
    expect(result.state).toBeNull();
    expect(result.supplyState).toBe(Supply.Disabled);
    expect(result.faultState).toBe(Fault.NoError);
  });
});
