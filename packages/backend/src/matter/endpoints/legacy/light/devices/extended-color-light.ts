import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import type { ColorControl } from "@matter/main/clusters";
import { ExtendedColorLightDevice as Device } from "@matter/main/devices";
import type { FeatureSelection } from "../../../../../utils/feature-selection.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { DefaultPowerSourceServer } from "../../../../behaviors/power-source-server.js";
import { LightColorControlServer } from "../behaviors/light-color-control-server.js";
import { LightLevelControlServer } from "../behaviors/light-level-control-server.js";
import { LightOnOffServer } from "../behaviors/light-on-off-server.js";

export const ExtendedColorLightType = (
  supportsColorControl: boolean,
  // kept for the call sites, CT is always advertised now (#452)
  _supportsTemperature: boolean,
  hasBattery = false,
) => {
  const features: FeatureSelection<typeof ColorControl.Cluster> = new Set();
  // Xy AND ColorTemperature are both mandatory for device type
  // ExtendedColorLight (0x010d) per Matter Device Library § 4.4. Leaving one
  // out makes the endpoint non-conformant and Alexa drops it (#452, same
  // class as #182). HueSaturation stays optional, only added for lights that
  // actually speak color.
  features.add("Xy");
  features.add("ColorTemperature");
  if (supportsColorControl) {
    features.add("HueSaturation");
  }

  if (hasBattery) {
    return Device.with(
      IdentifyServer,
      BasicInformationServer,
      HomeAssistantEntityBehavior,
      GroupsServer,
      ScenesManagementServer,
      LightOnOffServer,
      LightLevelControlServer,
      LightColorControlServer.with(...features),
      DefaultPowerSourceServer,
    );
  }

  return Device.with(
    IdentifyServer,
    BasicInformationServer,
    HomeAssistantEntityBehavior,
    GroupsServer,
    ScenesManagementServer,
    LightOnOffServer,
    LightLevelControlServer,
    LightColorControlServer.with(...features),
  );
};
