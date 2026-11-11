import type { EndpointType } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { PlugOnOffServer } from "../../../behaviors/on-off-server.js";

const AutomationOnOffServer = PlugOnOffServer({
  isOn: () => false,
  turnOn: () => ({
    action: "automation.trigger",
  }),
  turnOff: null,
  momentary: true,
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
