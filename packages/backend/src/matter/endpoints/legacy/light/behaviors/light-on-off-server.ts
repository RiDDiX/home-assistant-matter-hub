import { consumePendingColorStaging } from "../../../../behaviors/color-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  defaultOnOffAction,
  OnOffServer,
} from "../../../../behaviors/on-off-server.js";

export const LightOnOffServer = OnOffServer({
  turnOn: (_value, agent) => {
    const entityId = agent.get(HomeAssistantEntityBehavior).entityId;
    const staged = consumePendingColorStaging(entityId);
    if (entityId.startsWith("light.")) {
      return {
        action: "light.turn_on",
        data: staged,
      };
    }
    // Non-light entities overridden to on_off_switch reach the same domain
    // routing as the plug path (#65).
    return defaultOnOffAction(entityId, true);
  },
  turnOff: (_value, agent) =>
    defaultOnOffAction(agent.get(HomeAssistantEntityBehavior).entityId, false),
  isOn: (e) => e.state === "on",
}).with("Lighting");
