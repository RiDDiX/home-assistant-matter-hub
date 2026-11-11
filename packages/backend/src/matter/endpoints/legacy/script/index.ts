import type { EndpointType } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { PlugOnOffServer } from "../../../behaviors/on-off-server.js";

const ScriptOnOffServer = PlugOnOffServer({
  isOn: () => false,
  turnOn: () => ({
    action: "script.turn_on",
  }),
  turnOff: null,
  momentary: true,
});

const ScriptDeviceType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  ScriptOnOffServer,
);

export function ScriptDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return ScriptDeviceType.set({ homeAssistantEntity });
}
