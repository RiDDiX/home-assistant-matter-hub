import { OnOffServer } from "@matter/main/behaviors";
import { HomeAssistantActions } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { consumePendingColorStaging } from "../../../../behaviors/color-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  defaultOnOffAction,
  LightingOnOffServer,
} from "../../../../behaviors/on-off-server.js";

export const LightOnOffServer = LightingOnOffServer({
  turnOn: (_value, agent) => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;
    const staged = consumePendingColorStaging(entityId);
    if (entityId.startsWith("light.")) {
      // Google sends the color, then On. The light is on already, a bare
      // turn_on would only cut the color transition short (#542).
      const state = homeAssistant.entity.state;
      if (
        !staged &&
        agent.get(OnOffServer).state.onOff &&
        state.state === "on" &&
        state.attributes.assumed_state !== true &&
        // Optional call: test stubs do not define it.
        agent.env.get(HomeAssistantActions).lightChangedRecently?.(entityId)
      ) {
        return undefined;
      }
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
});
