import type { EndpointType } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

// No Lighting feature: it makes this non-light OnOffPlugInUnit non-conformant
// and Alexa rejects the device (#182, regressed via #364).
const AutomationOnOffServer = OnOffServer({
  isOn: () => false,
  turnOn: () => ({
    action: "automation.trigger",
  }),
  turnOff: null,
});

const AutomationDeviceType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  AutomationOnOffServer,
);

export function AutomationDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return AutomationDeviceType.set({ homeAssistantEntity });
}
