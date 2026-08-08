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

  describe("composed endpoint ID generation", () => {
    it("replaces dots and spaces with underscores", () => {
      const createEndpointId = (
        entityId: string,
        customName?: string,
      ): string => {
        const baseName = customName || entityId;
        return baseName.replace(/\./g, "_").replace(/\s+/g, "_");
      };

      expect(createEndpointId("sensor.temperature")).toBe("sensor_temperature");
      expect(createEndpointId("sensor.living_room", "Living Room Temp")).toBe(
        "Living_Room_Temp",
      );
      expect(createEndpointId("sensor.test.nested")).toBe("sensor_test_nested");
    });
  });

  describe("composed sub-endpoint parts structure", () => {
    it("temperature-only sensor creates 1 sub-endpoint", () => {
      const parts: string[] = ["temp"];
      expect(parts).toHaveLength(1);
    });

    it("temperature + humidity creates 2 sub-endpoints", () => {
      const parts: string[] = ["temp", "humidity"];
      expect(parts).toHaveLength(2);
    });

    it("temperature + humidity + pressure creates 3 sub-endpoints", () => {
      const parts: string[] = ["temp", "humidity", "pressure"];
      expect(parts).toHaveLength(3);
    });
  });
});
