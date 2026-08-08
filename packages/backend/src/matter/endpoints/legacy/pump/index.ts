import type { EndpointType } from "@matter/main";
import { PumpDevice } from "@matter/main/devices";
import type { HomeAssistantAction } from "../../../../services/home-assistant/home-assistant-actions.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";
import { DefaultPowerSourceServer } from "../../../behaviors/power-source-server.js";
import { PumpConfigurationAndControlServer } from "../../../behaviors/pump-configuration-and-control-server.js";

const PumpOnOffServer = OnOffServer({
  turnOn: (): HomeAssistantAction => ({ action: "turn_on" }),
  turnOff: (): HomeAssistantAction => ({ action: "turn_off" }),
});

const PumpType = PumpDevice.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  PumpOnOffServer,
  PumpConfigurationAndControlServer,
);

const PumpWithBatteryType = PumpDevice.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  PumpOnOffServer,
  PumpConfigurationAndControlServer,
  DefaultPowerSourceServer,
);

export function PumpEndpoint(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attrs = homeAssistantEntity.entity.state.attributes as {
    battery?: number;
    battery_level?: number;
  };
  const hasBatteryAttr = attrs.battery_level != null || attrs.battery != null;
  const hasBatteryEntity = !!homeAssistantEntity.mapping?.batteryEntity;

  const device =
    hasBatteryAttr || hasBatteryEntity ? PumpWithBatteryType : PumpType;

  return device.set({ homeAssistantEntity });
}
