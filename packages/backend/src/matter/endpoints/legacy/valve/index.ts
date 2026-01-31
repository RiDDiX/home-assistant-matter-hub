import type { EndpointType } from "@matter/main";
import { ValveConfigurationAndControl } from "@matter/main/clusters";
import { WaterValveDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { ValveConfigurationAndControlServer } from "../../../behaviors/valve-configuration-and-control-server.js";

const ValveServer = ValveConfigurationAndControlServer({
  getCurrentState: (state) => {
    switch (state.state) {
      case "open":
        return ValveConfigurationAndControl.ValveState.Open;
      case "opening":
      case "closing":
        return ValveConfigurationAndControl.ValveState.Transitioning;
      default:
        return ValveConfigurationAndControl.ValveState.Closed;
    }
  },
  open: () => ({ action: "valve.open_valve" }),
  close: () => ({ action: "valve.close_valve" }),
});

const ValveEndpointType = WaterValveDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  ValveServer,
);

export function ValveDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return ValveEndpointType.set({ homeAssistantEntity });
}
