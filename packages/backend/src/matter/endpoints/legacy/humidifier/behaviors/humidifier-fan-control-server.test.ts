import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { describe, expect, it } from "vitest";
import { humidifierFanControlConfig } from "./humidifier-fan-control-server.js";

function agentFor(attributes: Record<string, unknown>): Agent {
  const entityState = {
    entity_id: "humidifier.test",
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
