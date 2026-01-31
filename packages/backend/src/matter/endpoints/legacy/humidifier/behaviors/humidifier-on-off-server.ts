import { OnOffServer } from "../../../../behaviors/on-off-server.js";

export const HumidifierOnOffServer = OnOffServer({
  turnOn: () => ({
    action: "humidifier.turn_on",
  }),
  turnOff: () => ({
    action: "humidifier.turn_off",
  }),
});
