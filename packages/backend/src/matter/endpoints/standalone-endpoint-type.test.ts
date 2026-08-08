import { describe, expect, it } from "vitest";
import { DimmableLightType } from "./legacy/light/devices/dimmable-light.js";
import { OnOffLightType } from "./legacy/light/devices/on-off-light-device.js";
import { TemperatureSensorType } from "./legacy/sensor/devices/temperature-sensor.js";
import { asStandaloneEndpointType } from "./standalone-endpoint-type.js";
import { validateEndpointType } from "./validate-endpoint-type.js";

function behaviorKeys(type: unknown): string[] {
  return Object.keys(
    (type as { behaviors: Record<string, unknown> }).behaviors,
  );
}

const cases = [
  { name: "on/off light", type: OnOffLightType, entityId: "light.test" },
  { name: "dimmable light", type: DimmableLightType, entityId: "light.dim" },
  {
    name: "temperature sensor",
    type: TemperatureSensorType,
    entityId: "sensor.temp",
  },
];

describe("asStandaloneEndpointType", () => {
  for (const { name, type, entityId } of cases) {
    it(`drops the bridged identity for ${name} and stays valid`, () => {
      expect(behaviorKeys(type)).toContain("bridgedDeviceBasicInformation");
      const standalone = asStandaloneEndpointType(type);
      const keys = behaviorKeys(standalone);
      expect(keys).not.toContain("bridgedDeviceBasicInformation");
      expect(keys).toContain("homeAssistantEntity");
      expect((standalone as { deviceType: number }).deviceType).toBe(
        (type as unknown as { deviceType: number }).deviceType,
      );
      expect(() => validateEndpointType(standalone, entityId)).not.toThrow();
    });
  }

  it("keeps the core device behaviors for a light", () => {
    const keys = behaviorKeys(asStandaloneEndpointType(OnOffLightType));
    expect(keys).toEqual(
      expect.arrayContaining([
        "identify",
        "onOff",
        "groups",
        "homeAssistantEntity",
      ]),
    );
  });

  it("is a no-op once the bridged behavior is gone", () => {
    const once = asStandaloneEndpointType(OnOffLightType);
    expect(asStandaloneEndpointType(once)).toBe(once);
  });
});
