import { Logger } from "@matter/general";
import { OnOffServer as MatterOnOffServer } from "@matter/main/behaviors";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { OnOffServer } from "../../../../behaviors/on-off-server.js";

const logger = Logger.get("ClimateOnOffServer");

export const ClimateOnOffServer = OnOffServer({
  turnOn: (_value, agent) => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const entity = homeAssistant.entity;
    // IR controlled ACs are one way, HA only knows what it sent last, so the
    // skip below can leave a physically off device off. Opt in per entity to
    // always send the command (#462).
    if (homeAssistant.state.mapping?.climateForceTurnOn === true) {
      return { action: "climate.turn_on" };
    }
    // Skip only while cluster AND HA cache agree the device is on. The
    // attribute follows Matter commands immediately, so a power-on right after
    // a Matter power-off is honoured even while the HA cache lags (#441). The
    // attribute alone is not enough either: the optimistic holdback keeps it
    // true after a dispatched turn_on, and while HA still reads "off" the
    // device never turned on, so a controller retry has to go through.
    if (
      entity.state.state !== "off" &&
      agent.get(MatterOnOffServer).state.onOff
    ) {
      // Already on, skip to preserve the current HVAC mode.
      // Apple Home sends OnOff.on() before setting temperature;
      // climate.turn_on can switch Homematic from AUTO to MANUAL (#269).
      logger.debug(
        `[${entity.entity_id}] Skipping redundant OnOff.on(), cached state "${entity.state.state}"`,
      );
      return undefined;
    }
    return { action: "climate.turn_on" };
  },
  turnOff: () => ({ action: "climate.turn_off" }),
}).with("DeadFrontBehavior");
