import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { describe, expect, it } from "vitest";
import {
  humidityConfig,
  pressureConfig,
  temperatureConfig,
} from "./weather-device.js";

function entity(
  attributes: Record<string, unknown>,
  state = "sunny",
): HomeAssistantEntityState {
  return {
    entity_id: "weather.home",
    state,
    context: { id: "context" },
    last_changed: "any-change",
    last_updated: "any-update",
    attributes,
  };
}

// temperatureConfig is the only closure that touches the agent (fallback unit).
const agentStub = {
  env: { get: () => ({ unitSystem: { temperature: "°C" } }) },
} as unknown as Agent;

describe("weather getValue closures", () => {
  it("reads temperature from attributes, not the text state", () => {
    const value = temperatureConfig.getValue(
      entity({ temperature: 21, temperature_unit: "°C" }),
      agentStub,
    );
    expect(value?.celsius(false)).toBe(21);
    expect(temperatureConfig.getValue(entity({}), agentStub)).toBeUndefined();
  });

  it("converts the temperature unit from F to C", () => {
    const value = temperatureConfig.getValue(
      entity({ temperature: 212, temperature_unit: "°F" }),
      agentStub,
    );
    expect(value?.celsius(false)).toBeCloseTo(100);
  });

  it("returns humidity percent or null when absent", () => {
    expect(humidityConfig.getValue(entity({ humidity: 55 }), agentStub)).toBe(
      55,
    );
    expect(humidityConfig.getValue(entity({}), agentStub)).toBeNull();
  });

  it("converts pressure to hPa via pressure_unit before the clamp", () => {
    expect(
      pressureConfig.getValue(
        entity({ pressure: 1013, pressure_unit: "hPa" }),
        agentStub,
      ),
    ).toBe(1013);
    // 29.92 inHg is ~1013 hPa, which stays inside the 300-1100 range. Reading
    // it raw would land below 300 and the server would drop it.
    expect(
      pressureConfig.getValue(
        entity({ pressure: 29.92, pressure_unit: "inHg" }),
        agentStub,
      ),
    ).toBeCloseTo(1013.2, 1);
    expect(pressureConfig.getValue(entity({}), agentStub)).toBeUndefined();
  });
});
