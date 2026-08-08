import type { EndpointType } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

const SirenOnOffServer = OnOffServer({
  turnOn: () => ({
    action: "siren.turn_on",
  }),
  turnOff: () => ({
    action: "siren.turn_off",
  }),
});

const SirenDeviceType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  SirenOnOffServer,
);

export function SirenDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return SirenDeviceType.set({ homeAssistantEntity });
}
