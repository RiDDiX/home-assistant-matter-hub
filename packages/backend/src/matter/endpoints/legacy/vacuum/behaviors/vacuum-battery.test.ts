import { describe, expect, it } from "vitest";
import { mapChargingString } from "./vacuum-battery.js";

describe("mapChargingString (#377)", () => {
  it("maps charging values", () => {
    expect(mapChargingString("charging")).toBe("charging");
    expect(mapChargingString("go_charging")).toBe("charging");
    expect(mapChargingString("on")).toBe("charging");
  });

  it("maps full", () => {
    expect(mapChargingString("full")).toBe("full");
  });

  it("maps not-charging values", () => {
    expect(mapChargingString("not_charging")).toBe("not_charging");
    expect(mapChargingString("not_chargeable")).toBe("not_charging");
    expect(mapChargingString("discharging")).toBe("not_charging");
    expect(mapChargingString("off")).toBe("not_charging");
  });

  it("is case and space insensitive, null for unknown", () => {
    expect(mapChargingString(" Charging ")).toBe("charging");
    expect(mapChargingString("whatever")).toBeNull();
  });
});
