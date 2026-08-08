import type { EndpointType } from "@matter/main";
import { OnOffLightDevice, ThermostatDevice } from "@matter/main/devices";
import { describe, expect, it } from "vitest";
import { validateEndpointType } from "./validate-endpoint-type.js";

describe("validateEndpointType", () => {
  it("should return undefined for unknown device type", () => {
    const fakeType = {
      name: "Unknown",
      deviceType: 0xffff,
      deviceRevision: 1,
      deviceClass: 0,
      behaviors: {},
      requirements: {},
    };
    const result = validateEndpointType(fakeType as unknown as EndpointType);
    expect(result).toBeUndefined();
  });

  it("should report no missing mandatory clusters for OnOffLightDevice", () => {
    const result = validateEndpointType(OnOffLightDevice);
    expect(result).toBeDefined();
    expect(result!.deviceTypeName).toBe("OnOffLight");
    expect(result!.missingMandatory).toEqual([]);
    expect(result!.presentClusters).toContain("OnOff");
    expect(result!.presentClusters).toContain("Identify");
  });

  it("should detect missing mandatory clusters on a stripped endpoint", () => {
    const stripped = {
      ...OnOffLightDevice,
      behaviors: { onOff: OnOffLightDevice.behaviors.onOff },
    };
    const result = validateEndpointType(stripped as unknown as EndpointType);
    expect(result).toBeDefined();
    expect(result!.missingMandatory).toContain("Identify");
    expect(result!.missingMandatory).toContain("Groups");
    expect(result!.missingMandatory).toContain("ScenesManagement");
  });

  it("should list available optional clusters", () => {
    const result = validateEndpointType(OnOffLightDevice);
    expect(result).toBeDefined();
    expect(result!.availableOptional.length).toBeGreaterThan(0);
  });

  it("should include entityId prefix in result metadata", () => {
    const result = validateEndpointType(OnOffLightDevice, "light.living_room");
    expect(result).toBeDefined();
    expect(result!.deviceTypeId).toBe(0x0100);
  });

  it("should detect missing mandatory Thermostat cluster on base ThermostatDevice", () => {
    // ThermostatDevice base type only has Identify, Thermostat cluster
    // requires feature selection via .with() before it's added
    const result = validateEndpointType(ThermostatDevice);
    expect(result).toBeDefined();
    expect(result!.deviceTypeName).toBe("Thermostat");
    expect(result!.presentClusters).toContain("Identify");
    expect(result!.missingMandatory).toContain("Thermostat");
  });
});
