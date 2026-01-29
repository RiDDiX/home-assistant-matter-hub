import type { EndpointType } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import type { HomeAssistantAction } from "../../../../services/home-assistant/home-assistant-actions.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

// Alarm Panel uses OnOff to represent armed (on) / disarmed (off) state
// Matter doesn't have a native alarm panel device type, so we use OnOffPlugInUnit
// On = Armed (arm_away), Off = Disarmed
const AlarmPanelOnOffServer = OnOffServer({
  turnOn: (): HomeAssistantAction => ({
    action: "alarm_control_panel.alarm_arm_away",
  }),
  turnOff: (): HomeAssistantAction => ({
    action: "alarm_control_panel.alarm_disarm",
  }),
  isOn: (state) => {
    // Armed states: armed_away, armed_home, armed_night, armed_vacation, armed_custom_bypass, arming, pending
    // Disarmed states: disarmed, triggered (treat as "on" for visibility)
    const armedStates = [
      "armed_away",
      "armed_home",
      "armed_night",
      "armed_vacation",
      "armed_custom_bypass",
      "arming",
      "pending",
      "triggered",
    ];
    return armedStates.includes(state.state);
  },
});

const AlarmPanelEndpointType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  AlarmPanelOnOffServer,
);

export function AlarmControlPanelDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return AlarmPanelEndpointType.set({ homeAssistantEntity });
}
