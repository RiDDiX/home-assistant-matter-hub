import { EnergyEvse } from "@matter/main/clusters";

export interface EvseStatus {
  // null means HA reports an unknown/unmatched status, so State is cleared and
  // the EVSE is left disabled rather than claiming a charge condition.
  state: EnergyEvse.State | null;
  supplyState: EnergyEvse.SupplyState;
  faultState: EnergyEvse.FaultState;
}

// HA has no charger status convention, so map raw status strings by keyword.
// First match wins. The order matters: "not connected" contains "connected",
// and "discharging" contains "charg", so the narrower checks run first.
export function mapEvseStatus(
  rawState: string,
  chargingSwitchOn: boolean,
): EvseStatus {
  const raw = rawState.toLowerCase().trim();

  // When the switch is on the wallbox is permitting charging, otherwise it is
  // disabled. Used for plugged-in-idle and not-plugged-in states.
  const switchSupply = chargingSwitchOn
    ? EnergyEvse.SupplyState.ChargingEnabled
    : EnergyEvse.SupplyState.Disabled;

  if (raw === "" || raw === "unknown" || raw === "unavailable") {
    return {
      state: null,
      supplyState: EnergyEvse.SupplyState.Disabled,
      faultState: EnergyEvse.FaultState.NoError,
    };
  }

  if (raw.includes("error") || raw.includes("fault")) {
    return {
      state: EnergyEvse.State.Fault,
      supplyState: EnergyEvse.SupplyState.DisabledError,
      faultState: EnergyEvse.FaultState.Other,
    };
  }

  // Check "not connected" before the plain "connected" branch below.
  if (
    raw.includes("not connected") ||
    raw.includes("not_connected") ||
    raw.includes("disconnected") ||
    raw.includes("no vehicle")
  ) {
    return {
      state: EnergyEvse.State.NotPluggedIn,
      supplyState: switchSupply,
      faultState: EnergyEvse.FaultState.NoError,
    };
  }

  // "not charging" contains "charg" but the car is plugged in and idle, so it
  // must be caught before the charging branch (same precedence trick as "not
  // connected"). Falls into the switch-dependent no-demand semantics below.
  if (
    raw.includes("not charging") ||
    raw.includes("not_charging") ||
    raw.includes("not-charging")
  ) {
    return {
      state: EnergyEvse.State.PluggedInNoDemand,
      supplyState: switchSupply,
      faultState: EnergyEvse.FaultState.NoError,
    };
  }

  // Plugged in but idle: ready, awaiting start, finished, paused, sleeping.
  // These win over "charg", as in "ready_to_charge" or "charge complete".
  // "charged" must not match the V2X "discharged".
  const idle =
    /ready|awaiting|complete|(?<!dis)charged|done|finish|sleep|paused/.test(
      raw,
    );

  // Actively charging, but exclude discharging (V2X / vehicle-to-home).
  if (!idle && raw.includes("charg") && !raw.includes("discharg")) {
    return {
      state: EnergyEvse.State.PluggedInCharging,
      supplyState: EnergyEvse.SupplyState.ChargingEnabled,
      faultState: EnergyEvse.FaultState.NoError,
    };
  }

  if (idle || raw.includes("connected")) {
    return {
      state: EnergyEvse.State.PluggedInNoDemand,
      supplyState: switchSupply,
      faultState: EnergyEvse.FaultState.NoError,
    };
  }

  // Unmatched status: honest passthrough, leave the EVSE disabled.
  return {
    state: null,
    supplyState: EnergyEvse.SupplyState.Disabled,
    faultState: EnergyEvse.FaultState.NoError,
  };
}
