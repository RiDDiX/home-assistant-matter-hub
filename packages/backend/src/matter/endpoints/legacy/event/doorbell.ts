import type { EventDeviceAttributes } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { DoorbellDevice as Base } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import {
  HaGenericSwitchServer,
  HaGenericSwitchServerSimple,
} from "../../../behaviors/generic-switch-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { detectMultiPressMax } from "./index.js";

// Doorbell (0x148) ships only Identify by default; the mandatory Switch with
// MomentarySwitch comes from the Ha switch servers. The spec also mandates a
// Chime CLIENT cluster, but matter.js only instantiates servers, so the
// endpoint goes without it.

const DoorbellEndpointTypeMulti = Base.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HaGenericSwitchServer,
);

const DoorbellEndpointTypeSimple = Base.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HaGenericSwitchServerSimple,
);

export function DoorbellDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attrs = homeAssistantEntity.entity.state
    .attributes as EventDeviceAttributes;
  const multiPressMax = detectMultiPressMax(attrs.event_types ?? []);
  if (multiPressMax >= 2) {
    return DoorbellEndpointTypeMulti.set({
      homeAssistantEntity,
      switch: { multiPressMax },
    });
  }
  return DoorbellEndpointTypeSimple.set({
    homeAssistantEntity,
  });
}
