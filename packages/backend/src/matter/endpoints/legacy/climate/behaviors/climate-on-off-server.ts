import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { OnOffServer } from "../../../../behaviors/on-off-server.js";

export const ClimateOnOffServer = OnOffServer({
  turnOn: (_value, agent) => {
    const entity = agent.get(HomeAssistantEntityBehavior).entity;
    if (entity.state.state !== "off") {
      // Already on, skip to preserve the current HVAC mode.
      // Apple Home sends OnOff.on() before setting temperature;
      // climate.turn_on can switch Homematic from AUTO to MANUAL (#269).
      return undefined;
    }
    return { action: "climate.turn_on" };
  },
  turnOff: () => ({ action: "climate.turn_off" }),
}).with("DeadFrontBehavior");
