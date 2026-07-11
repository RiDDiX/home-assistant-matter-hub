import type { EndpointType } from "@matter/main";
import { OnOffServer as Base } from "@matter/main/behaviors";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";

/**
 * Button-specific OnOffServer that auto-resets to OFF after press.
 * This prevents buttons from appearing "stuck on" in controllers like Google Home.
 * No Lighting feature: like automation and input button, Alexa rejects a
 * non-light OnOffPlugInUnit that advertises it (#182).
 */
class ButtonOnOffServerBase extends Base {
  override async initialize() {
    await super.initialize();
    // Buttons are always "off" - they're momentary actions
    applyPatchState(this.state, { onOff: false });
  }

  override on() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction({ action: "button.press" });
    // Auto-reset to OFF after 1 second so button doesn't stay "on"
    setTimeout(this.callback(this.resetToOff), 1000);
  }

  override off() {
    // Buttons don't have an "off" action, just reset state
    setTimeout(this.callback(this.resetToOff), 100);
  }

  private resetToOff() {
    applyPatchState(this.state, { onOff: false });
  }
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
