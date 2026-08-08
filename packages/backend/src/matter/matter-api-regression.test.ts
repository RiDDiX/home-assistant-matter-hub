/**
 * Regression tests for matter.js internal APIs used by HAMH.
 *
 * These tests verify that the matter.js APIs HAMH depends on still exist
 * and behave as expected. If a matter.js upgrade breaks any of these tests,
 * the corresponding HAMH code must be updated.
 *
 * See docs-site/docs/developer/index.md "Known Internal API Dependencies"
 * for the full dependency table.
 */
import { Environment, Logger } from "@matter/general";
import { Endpoint, MutableEndpoint } from "@matter/main";
import {
  BridgedDeviceBasicInformationServer,
  IdentifyServer,
} from "@matter/main/behaviors";
import {
  DimmableLightDevice,
  HumiditySensorDevice,
  OnOffLightDevice,
  OnOffPlugInUnitDevice,
  TemperatureSensorDevice,
  ThermostatDevice,
} from "@matter/main/devices";
import {
  AggregatorEndpoint,
  BridgedNodeEndpoint,
} from "@matter/main/endpoints";
import { ServerNode } from "@matter/main/node";
import { SessionManager } from "@matter/main/protocol";
import { describe, expect, it } from "vitest";

describe("matter.js API regression", () => {
  describe("MutableEndpoint.with(), behavior composition", () => {
    it("should compose OnOffLightDevice with IdentifyServer", () => {
      const Composed = OnOffLightDevice.with(IdentifyServer);
      expect(Composed).toBeDefined();
      expect(Composed.behaviors).toBeDefined();
      expect(Composed.behaviors.identify).toBeDefined();
    });

    it("should compose DimmableLightDevice with BridgedDeviceBasicInformation", () => {
      const Composed = DimmableLightDevice.with(
        BridgedDeviceBasicInformationServer,
      );
      expect(Composed).toBeDefined();
      expect(Composed.behaviors.bridgedDeviceBasicInformation).toBeDefined();
    });

    it("should compose multiple behaviors at once", () => {
      const Composed = OnOffPlugInUnitDevice.with(
        IdentifyServer,
        BridgedDeviceBasicInformationServer,
      );
      expect(Composed).toBeDefined();
      expect(Composed.behaviors.identify).toBeDefined();
      expect(Composed.behaviors.bridgedDeviceBasicInformation).toBeDefined();
    });

    it("should preserve device type metadata after composition", () => {
      const Composed = OnOffLightDevice.with(IdentifyServer);
      expect(Composed.deviceType).toBe(OnOffLightDevice.deviceType);
      expect(Composed.deviceRevision).toBe(OnOffLightDevice.deviceRevision);
    });
  });

  describe("Device type exports, all HAMH-used types exist", () => {
    it("should export OnOffLightDevice", () => {
      expect(OnOffLightDevice).toBeDefined();
      expect(OnOffLightDevice.deviceType).toBeDefined();
    });

    it("should export DimmableLightDevice", () => {
      expect(DimmableLightDevice).toBeDefined();
    });

    it("should export ThermostatDevice", () => {
      expect(ThermostatDevice).toBeDefined();
    });

    it("should export TemperatureSensorDevice", () => {
      expect(TemperatureSensorDevice).toBeDefined();
    });

    it("should export HumiditySensorDevice", () => {
      expect(HumiditySensorDevice).toBeDefined();
    });

    it("should export OnOffPlugInUnitDevice", () => {
      expect(OnOffPlugInUnitDevice).toBeDefined();
    });

    it("should export AggregatorEndpoint", () => {
      expect(AggregatorEndpoint).toBeDefined();
    });

    it("should export BridgedNodeEndpoint", () => {
      expect(BridgedNodeEndpoint).toBeDefined();
    });
  });

  describe("SessionManager, session diagnostics API", () => {
    it("should be importable from @matter/main", () => {
      expect(SessionManager).toBeDefined();
    });

    it("should have sessions property descriptor", () => {
      // Verify the 'sessions' getter exists on the prototype
      const descriptor = Object.getOwnPropertyDescriptor(
        SessionManager.prototype,
        "sessions",
      );
      expect(descriptor?.get ?? descriptor?.value).toBeDefined();
    });
  });

  describe("Endpoint, core API", () => {
    it("should export Endpoint class from @matter/main", () => {
      expect(Endpoint).toBeDefined();
    });

    it("should export MutableEndpoint from @matter/main", () => {
      expect(MutableEndpoint).toBeDefined();
    });
  });

  describe("ServerNode, bridge lifecycle", () => {
    it("should export ServerNode from @matter/main", () => {
      expect(ServerNode).toBeDefined();
    });

    it("should have create static method", () => {
      expect(typeof ServerNode.create).toBe("function");
    });
  });

  describe("Environment, service container", () => {
    it("should export Environment from @matter/general", () => {
      expect(Environment).toBeDefined();
    });

    it("should have default property", () => {
      expect(Environment.default).toBeDefined();
    });
  });

  describe("Logger, logging API", () => {
    it("should export Logger from @matter/general", () => {
      expect(Logger).toBeDefined();
    });

    it("should have get() factory method", () => {
      expect(typeof Logger.get).toBe("function");
      const logger = Logger.get("TestLogger");
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.debug).toBe("function");
    });
  });
});
