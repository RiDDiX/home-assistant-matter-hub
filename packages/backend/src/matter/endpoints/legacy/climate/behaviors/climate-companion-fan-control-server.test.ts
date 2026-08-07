import {
  type ClimateDeviceAttributes,
  ClimateHvacMode,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { describe, expect, it } from "vitest";
import {
  ClimateCompanionFanControlServer,
  companionFanControlConfig,
  fanOffAction,
  isFanOnly,
} from "./climate-companion-fan-control-server.js";

function state(hvacState: ClimateHvacMode): HomeAssistantEntityState {
  return {
    entity_id: "climate.test",
    state: hvacState,
    context: { id: "ctx" },
    last_changed: "x",
    last_updated: "x",
    attributes: {} as ClimateDeviceAttributes,
  };
}

describe("fanOffAction (#309 companion fan)", () => {
  it("turns the AC off instead of forcing a cooling mode", () => {
    expect(fanOffAction()).toEqual({ action: "climate.turn_off" });
  });

  it("never switches the AC into a cooling or heating mode", () => {
    const action = fanOffAction();
    expect(action.action).not.toBe("climate.set_hvac_mode");
    expect(action.data).toBeUndefined();
  });
});

// The compiled feature set is only exposed through the untyped defaults.
function compiledAuto(server: { defaults: object }): boolean {
  return (server.defaults as { featureMap: { auto: boolean } }).featureMap.auto;
}

describe("ClimateCompanionFanControlServer auto gating (#436)", () => {
  it("compiles the Auto feature only when the entity has an auto fan mode", () => {
    expect(compiledAuto(ClimateCompanionFanControlServer(true))).toBe(true);
    expect(compiledAuto(ClimateCompanionFanControlServer(false))).toBe(false);
  });

  it("keeps Auto by default for untouched callers", () => {
    expect(compiledAuto(ClimateCompanionFanControlServer())).toBe(true);
  });
});

describe("isFanOnly (#309 companion fan)", () => {
  it("is true only while the AC is in fan_only", () => {
    expect(isFanOnly(state(ClimateHvacMode.fan_only))).toBe(true);
    expect(isFanOnly(state(ClimateHvacMode.cool))).toBe(false);
    expect(isFanOnly(state(ClimateHvacMode.off))).toBe(false);
    expect(isFanOnly(state(ClimateHvacMode.auto))).toBe(false);
  });
});

function agentFor(attributes: Record<string, unknown>): Agent {
  const entityState = {
    entity_id: "climate.test",
    state: ClimateHvacMode.fan_only,
    attributes,
    context: { id: "ctx" },
    last_changed: "x",
    last_updated: "x",
  } as unknown as HomeAssistantEntityState;
  return {
    get: () => ({ state: { entity: { state: entityState } } }),
  } as unknown as Agent;
}

// #436 review: the Auto feature gate matches fan modes case-insensitively,
// but setAutoMode sent the literal "auto". HA fan mode names are
// case-sensitive, so an entity declaring "AUTO" rejected the call.
describe("companion setAutoMode fan mode casing (#436)", () => {
  it("sends the entity's own auto fan mode name", () => {
    const agent = agentFor({ fan_modes: ["AUTO", "Low", "High"] });
    expect(companionFanControlConfig.setAutoMode(undefined, agent)).toEqual({
      action: "climate.set_fan_mode",
      data: { fan_mode: "AUTO" },
    });
  });

  it("falls back to the literal when no auto mode is listed", () => {
    const agent = agentFor({ fan_modes: ["Low", "High"] });
    expect(companionFanControlConfig.setAutoMode(undefined, agent)).toEqual({
      action: "climate.set_fan_mode",
      data: { fan_mode: "auto" },
    });
  });
});
