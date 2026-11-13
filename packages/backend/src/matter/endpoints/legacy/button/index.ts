import type { EndpointType } from "@matter/main";
import { OnOffServer as Base } from "@matter/main/behaviors";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";

/**
 * Button-specific OnOffServer that never turns on, so buttons do not appear
 * "stuck on" in controllers like Google Home. Every on path (toggle, timed,
 * scene) goes through on(), which only presses the button.
 * Lighting is mandatory on OnOffPlugInUnit. A timed off only lands in off(),
 * which never calls HA here.
 */
class ButtonOnOffServerBase extends Base.with("Lighting") {
  override async initialize() {
    await super.initialize();
    // Buttons are always "off" - they're momentary actions
    applyPatchState(this.state, { onOff: false });
  }

  override on() {
    this.agent
      .get(HomeAssistantEntityBehavior)
      .callAction({ action: "button.press" });
  }

  // Buttons have no "off" action and onOff never leaves false.
  override off() {}
}

const ButtonEndpointType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  ButtonOnOffServerBase,
);

export function ButtonDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return ButtonEndpointType.set({ homeAssistantEntity });
}
