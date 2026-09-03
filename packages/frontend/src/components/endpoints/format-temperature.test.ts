import { describe, expect, it } from "vitest";
import { formatTemperature } from "./EndpointCard";

// #472: a Fahrenheit Home Assistant showed Celsius chips because the card
// printed the raw Matter value with a hardcoded unit.

describe("formatTemperature", () => {
  it("follows the thermostat's display mode", () => {
    const state = {
      thermostatUserInterfaceConfiguration: { temperatureDisplayMode: 1 },
    };
    expect(formatTemperature(2222, state)).toBe("72.0°F");
  });

  it("follows the sensor's unit_of_measurement", () => {
    const state = {
      homeAssistantEntity: {
        entity: { state: { attributes: { unit_of_measurement: "°F" } } },
      },
    };
    expect(formatTemperature(2222, state)).toBe("72.0°F");
  });

  it("follows a weather entity's temperature_unit", () => {
    const state = {
      homeAssistantEntity: {
        entity: { state: { attributes: { temperature_unit: "°F" } } },
      },
    };
    expect(formatTemperature(0, state)).toBe("32.0°F");
  });

  it("stays Celsius without a unit hint", () => {
    expect(formatTemperature(2100, {})).toBe("21.0°C");
    expect(formatTemperature(-725, {})).toBe("-7.3°C");
  });

  it("stays Celsius when the thermostat reports Celsius", () => {
    const state = {
      thermostatUserInterfaceConfiguration: { temperatureDisplayMode: 0 },
    };
    expect(formatTemperature(2100, state)).toBe("21.0°C");
  });
});
