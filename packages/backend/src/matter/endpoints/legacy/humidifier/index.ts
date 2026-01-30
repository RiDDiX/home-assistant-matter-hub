import type { HumidiferDeviceAttributes } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { FanDevice as Device } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import {
  HumidifierFanControlServer,
  HumidifierFanControlServerWithAuto,
} from "./behaviors/humidifier-fan-control-server.js";
import { HumidifierHumidityMeasurementServer } from "./behaviors/humidifier-humidity-measurement-server.js";
import { HumidifierOnOffServer } from "./behaviors/humidifier-on-off-server.js";

// Device types for different feature combinations
const HumidifierBasic = Device.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HumidifierOnOffServer,
  HumidifierFanControlServer,
);

const HumidifierWithAuto = Device.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HumidifierOnOffServer,
  HumidifierFanControlServerWithAuto,
);

const HumidifierWithSensor = Device.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HumidifierOnOffServer,
  HumidifierFanControlServer,
  HumidifierHumidityMeasurementServer,
);

const HumidifierWithAutoAndSensor = Device.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HumidifierOnOffServer,
  HumidifierFanControlServerWithAuto,
  HumidifierHumidityMeasurementServer,
);

export function HumidifierDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as HumidiferDeviceAttributes;

  // Check if device supports Auto mode
  const availableModes = attributes.available_modes ?? [];
  const supportsAuto = availableModes.some((m) => m.toLowerCase() === "auto");

  // Check if device has current humidity sensor
  const hasHumiditySensor = attributes.current_humidity != null;

  // Select appropriate device type based on features
  if (supportsAuto && hasHumiditySensor) {
    return HumidifierWithAutoAndSensor.set({ homeAssistantEntity });
  }
  if (supportsAuto) {
    return HumidifierWithAuto.set({ homeAssistantEntity });
  }
  if (hasHumiditySensor) {
    return HumidifierWithSensor.set({ homeAssistantEntity });
  }
  return HumidifierBasic.set({ homeAssistantEntity });
}
