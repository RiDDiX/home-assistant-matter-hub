import type { EndpointType } from "@matter/main";
import { PumpDevice } from "@matter/main/devices";
import type { HomeAssistantAction } from "../../../../services/home-assistant/home-assistant-actions.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

const PumpOnOffServer = OnOffServer({
  turnOn: (): HomeAssistantAction => ({ action: "turn_on" }),
  turnOff: (): HomeAssistantAction => ({ action: "turn_off" }),
});

const PumpType = PumpDevice.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  PumpOnOffServer,
);

export function PumpEndpoint(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return PumpType.set({ homeAssistantEntity });
}
