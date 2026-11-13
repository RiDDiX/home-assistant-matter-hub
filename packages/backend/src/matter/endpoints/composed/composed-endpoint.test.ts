import {
  AirPurifierDevice,
  HumiditySensorDevice,
  PressureSensorDevice,
  TemperatureSensorDevice,
} from "@matter/main/devices";
import { BridgedNodeEndpoint } from "@matter/main/endpoints";
import { describe, expect, it } from "vitest";
import { validateEndpointType } from "../validate-endpoint-type.js";

describe("composed endpoint type validation", () => {
  describe("ComposedSensorEndpoint sub-types", () => {
    it("TemperatureSensorDevice has no missing mandatory clusters", () => {
      const result = validateEndpointType(
        TemperatureSensorDevice,
        "sensor.temp_test",
      );
      expect(result).toBeDefined();
      expect(result!.missingMandatory).toEqual([]);
    });

    it("HumiditySensorDevice has no missing mandatory clusters", () => {
      const result = validateEndpointType(
        HumiditySensorDevice,
        "sensor.humidity_test",
      );
      expect(result).toBeDefined();
      expect(result!.missingMandatory).toEqual([]);
    });

    it("PressureSensorDevice has no missing mandatory clusters", () => {
      const result = validateEndpointType(
        PressureSensorDevice,
        "sensor.pressure_test",
      );
      expect(result).toBeDefined();
      expect(result!.missingMandatory).toEqual([]);
    });

    it("BridgedNodeEndpoint is valid as composed parent", () => {
      const result = validateEndpointType(
        BridgedNodeEndpoint,
        "sensor.parent_test",
      );
      expect(result).toBeDefined();
      expect(result!.missingMandatory).toEqual([]);
    });
  });

  describe("ComposedAirPurifierEndpoint sub-types", () => {
    it("AirPurifierDevice has no missing mandatory clusters", () => {
      const result = validateEndpointType(
        AirPurifierDevice,
        "fan.air_purifier_test",
      );
      expect(result).toBeDefined();
      expect(result!.missingMandatory).toEqual([]);
    });
  });
});
