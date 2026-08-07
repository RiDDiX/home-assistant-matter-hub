import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { describe, expect, it } from "vitest";
import { fanControlConfig } from "./fan-fan-control-server.js";

// #436 review: setAutoMode sent the literal preset "Auto", but Home Assistant
// preset names are case-sensitive, so an entity whose preset is "auto" rejected
// the call. The command must use the preset name the entity actually declares.

function agentFor(attributes: Record<string, unknown>): Agent {
  const entityState = {
    entity_id: "fan.test",
    state: "on",
    attributes,
    context: { id: "ctx" },
    last_changed: "x",
    last_updated: "x",
  } as unknown as HomeAssistantEntityState;
  return {
    get: () => ({ state: { entity: { state: entityState } } }),
  } as unknown as Agent;
}

describe("fan setAutoMode preset casing (#436)", () => {
  it("sends the entity's own auto preset name", () => {
    const agent = agentFor({ preset_modes: ["auto", "low", "high"] });
    expect(fanControlConfig.setAutoMode(undefined, agent)).toEqual({
      action: "fan.turn_on",
      data: { preset_mode: "auto" },
    });
  });

  it("keeps the entity's casing when it differs", () => {
    const agent = agentFor({ preset_modes: ["AUTO", "low"] });
    expect(fanControlConfig.setAutoMode(undefined, agent)).toEqual({
      action: "fan.turn_on",
      data: { preset_mode: "AUTO" },
    });
  });
});
