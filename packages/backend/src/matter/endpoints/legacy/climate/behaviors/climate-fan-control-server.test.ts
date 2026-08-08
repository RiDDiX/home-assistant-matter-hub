import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { describe, expect, it } from "vitest";
import {
  climateFanControlConfig,
  rockSettingToSwingMode,
  swingModesToRockSupport,
  swingModeToRockSetting,
} from "./climate-fan-control-server.js";

function agentFor(attributes: Record<string, unknown>): Agent {
  const entityState = {
    entity_id: "climate.test",
    state: "fan_only",
    attributes,
    context: { id: "ctx" },
    last_changed: "x",
    last_updated: "x",
  } as unknown as HomeAssistantEntityState;
  return {
    get: () => ({ state: { entity: { state: entityState } } }),
  } as unknown as Agent;
}

describe("climate fan rocking", () => {
  it("maps HA swing modes to Matter rock support", () => {
    expect(swingModesToRockSupport(["off", "vertical"])).toEqual({
      rockLeftRight: undefined,
      rockUpDown: true,
    });
    expect(swingModesToRockSupport(["off", "horizontal"])).toEqual({
      rockLeftRight: true,
      rockUpDown: undefined,
    });
    expect(swingModesToRockSupport(["off", "both"])).toEqual({
      rockLeftRight: true,
      rockUpDown: true,
    });
  });

  it("maps HA swing mode to Matter rock setting", () => {
    expect(swingModeToRockSetting("off")).toEqual({});
    expect(swingModeToRockSetting("vertical")).toEqual({ rockUpDown: true });
    expect(swingModeToRockSetting("horizontal")).toEqual({
      rockLeftRight: true,
    });
    expect(swingModeToRockSetting("both")).toEqual({
      rockLeftRight: true,
      rockUpDown: true,
    });
  });

  it("maps Matter rock setting back to HA swing mode", () => {
    expect(rockSettingToSwingMode({})).toBe("off");
    expect(rockSettingToSwingMode({ rockUpDown: true })).toBe("vertical");
    expect(rockSettingToSwingMode({ rockLeftRight: true })).toBe("horizontal");
    expect(
      rockSettingToSwingMode({ rockLeftRight: true, rockUpDown: true }),
    ).toBe("both");
  });
});

// #436 review: the Auto feature gate matches fan modes case-insensitively,
// but setAutoMode sent the literal "auto". HA fan mode names are
// case-sensitive, so an entity declaring "AUTO" rejected the call.
describe("climate setAutoMode fan mode casing (#436)", () => {
  it("sends the entity's own auto fan mode name", () => {
    const agent = agentFor({ fan_modes: ["AUTO", "Low", "High"] });
    expect(climateFanControlConfig.setAutoMode(undefined, agent)).toEqual({
      action: "climate.set_fan_mode",
      data: { fan_mode: "AUTO" },
    });
  });

  it("falls back to the literal when no auto mode is listed", () => {
    const agent = agentFor({ fan_modes: ["Low", "High"] });
    expect(climateFanControlConfig.setAutoMode(undefined, agent)).toEqual({
      action: "climate.set_fan_mode",
      data: { fan_mode: "auto" },
    });
  });
});
