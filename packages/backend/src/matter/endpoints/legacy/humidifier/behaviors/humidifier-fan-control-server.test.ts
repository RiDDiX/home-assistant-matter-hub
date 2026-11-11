import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { describe, expect, it, vi } from "vitest";
import { humidifierFanControlConfig } from "./humidifier-fan-control-server.js";

function agentFor(
  attributes: Record<string, unknown>,
  state = "on",
  callAction = vi.fn(),
): Agent {
  const entityState = {
    entity_id: "humidifier.test",
    state,
    attributes,
    context: { id: "ctx" },
    last_changed: "x",
    last_updated: "x",
  } as unknown as HomeAssistantEntityState;
  return {
    get: () => ({ state: { entity: { state: entityState } }, callAction }),
  } as unknown as Agent;
}

// #436 review: the Auto feature gate matches available_modes
// case-insensitively, but setAutoMode sent the literal "auto". HA mode names
// are case-sensitive, so an entity declaring "Auto" rejected the call.
describe("humidifier setAutoMode casing (#436)", () => {
  it("sends the entity's own auto mode name", () => {
    const agent = agentFor({ available_modes: ["Auto", "normal"] });
    expect(humidifierFanControlConfig.setAutoMode(undefined, agent)).toEqual({
      action: "humidifier.set_mode",
      data: { mode: "Auto" },
    });
  });

  it("falls back to the literal when no auto mode is listed", () => {
    const agent = agentFor({ available_modes: ["normal", "eco"] });
    expect(humidifierFanControlConfig.setAutoMode(undefined, agent)).toEqual({
      action: "humidifier.set_mode",
      data: { mode: "auto" },
    });
  });
});

describe("humidifier target humidity as fan percent", () => {
  it("reads 0 while off even though HA keeps the target", () => {
    const state = {
      state: "off",
      attributes: { humidity: 50 },
    } as unknown as HomeAssistantEntityState;
    expect(humidifierFanControlConfig.getPercentage(state, agentFor({}))).toBe(
      0,
    );
  });

  it("clamps the written percent to min/max humidity", () => {
    const agent = agentFor({ min_humidity: 30, max_humidity: 80 });
    expect(humidifierFanControlConfig.turnOn(20, agent)).toEqual({
      action: "humidifier.set_humidity",
      data: { humidity: 30 },
    });
    expect(humidifierFanControlConfig.turnOn(100, agent)).toEqual({
      action: "humidifier.set_humidity",
      data: { humidity: 80 },
    });
  });

  it("turns on without set_humidity for the power-on 100 while off", () => {
    const callAction = vi.fn();
    const agent = agentFor(
      { humidity: 50, max_humidity: 80 },
      "off",
      callAction,
    );
    expect(humidifierFanControlConfig.turnOn(100, agent)).toEqual({
      action: "humidifier.turn_on",
    });
    expect(callAction).not.toHaveBeenCalled();
  });

  // A lower value while off is still a deliberate target (#387), but HA's
  // set_humidity does not power the humidifier on, so the tile flipped back
  // to off. It must turn on and keep the written target.
  it("turns on and sets the target for a lower value while off", () => {
    const callAction = vi.fn();
    const agent = agentFor(
      { humidity: 50, max_humidity: 80 },
      "off",
      callAction,
    );
    expect(humidifierFanControlConfig.turnOn(40, agent)).toEqual({
      action: "humidifier.set_humidity",
      data: { humidity: 40 },
    });
    expect(callAction).toHaveBeenCalledWith({ action: "humidifier.turn_on" });
  });

  it("sends only set_humidity while on", () => {
    const callAction = vi.fn();
    const agent = agentFor({ humidity: 50 }, "on", callAction);
    humidifierFanControlConfig.turnOn(40, agent);
    expect(callAction).not.toHaveBeenCalled();
  });
});
