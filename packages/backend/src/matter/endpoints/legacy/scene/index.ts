import type { EndpointType } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { PlugOnOffServer } from "../../../behaviors/on-off-server.js";

/**
 * Scene-specific OnOffServer that always shows as OFF.
 * Scenes are momentary actions - they activate and immediately reset.
 * Using isOn: () => false ensures scenes never appear "stuck on" in controllers.
 */
const SceneOnOffServer = PlugOnOffServer({
  isOn: () => false,
  turnOn: () => ({
    action: "scene.turn_on",
  }),
  turnOff: null,
  momentary: true,
});

const SceneDeviceType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  SceneOnOffServer,
);

export function SceneDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return SceneDeviceType.set({ homeAssistantEntity });
}
