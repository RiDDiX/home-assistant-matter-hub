import {
  type BinarySensorDeviceAttributes,
  BinarySensorDeviceClass,
  type HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { BinarySensorDevice } from "./index.js";

// Matter 1.3 ContactSensor device type id (0x0015).
const CONTACT_SENSOR = 0x15;

function deviceTypeFor(deviceClass: BinarySensorDeviceClass): number {
  const entity = {
    entity_id: "binary_sensor.test",
    state: {
      entity_id: "binary_sensor.test",
      state: "on",
      attributes: { device_class: deviceClass } as BinarySensorDeviceAttributes,
      context: { id: "c" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
    },
  } as HomeAssistantEntityInformation;
  // biome-ignore lint/suspicious/noExplicitAny: read the device type off the EndpointType
  const type = BinarySensorDevice({ entity } as never) as any;
  return type.deviceType;
}

describe("binary sensor detector types are 1.3-safe (#365)", () => {
  it("maps moisture/cold to the 1.3 ContactSensor, not a Matter 1.4 detector", () => {
    // The dedicated WaterLeak/WaterFreeze device types are Matter 1.4, and
    // Alexa (1.3) rejects them, which breaks the whole-bridge subscription.
    expect(deviceTypeFor(BinarySensorDeviceClass.Moisture)).toBe(
      CONTACT_SENSOR,
    );
    expect(deviceTypeFor(BinarySensorDeviceClass.Cold)).toBe(CONTACT_SENSOR);
  });

  it("keeps a door sensor as a ContactSensor (control)", () => {
    expect(deviceTypeFor(BinarySensorDeviceClass.Door)).toBe(CONTACT_SENSOR);
  });
});
