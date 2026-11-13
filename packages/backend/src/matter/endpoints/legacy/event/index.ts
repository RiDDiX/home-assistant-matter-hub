import type { EventDeviceAttributes } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { GenericSwitchDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import {
  HaGenericSwitchServer,
  HaGenericSwitchServerSimple,
  pressCountOf,
} from "../../../behaviors/generic-switch-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";

const EventEndpointTypeMulti = GenericSwitchDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HaGenericSwitchServer,
);

const EventEndpointTypeSimple = GenericSwitchDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HaGenericSwitchServerSimple,
);

export function detectMultiPressMax(eventTypes: string[]): number {
  return Math.max(1, ...eventTypes.map(pressCountOf));
}

export function EventDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attrs = homeAssistantEntity.entity.state
    .attributes as EventDeviceAttributes;
  const multiPressMax = detectMultiPressMax(attrs.event_types ?? []);
  if (multiPressMax >= 2) {
    return EventEndpointTypeMulti.set({
      homeAssistantEntity,
      switch: { multiPressMax },
    });
  }
  return EventEndpointTypeSimple.set({
    homeAssistantEntity,
  });
}
