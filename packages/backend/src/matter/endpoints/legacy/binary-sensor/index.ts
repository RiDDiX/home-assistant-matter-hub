import {
  type BinarySensorDeviceAttributes,
  BinarySensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import type { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { ContactSensorType } from "./contact-sensor.js";
import { OccupancySensorType } from "./occupancy-sensor.js";
import { OnOffSensorType } from "./on-off-sensor.js";
import { CoAlarmType, SmokeAlarmType } from "./smoke-co-alarm.js";
import { WaterLeakDetectorType } from "./water-leak-detector.js";

type CombinedType =
  | typeof ContactSensorType
  | typeof OccupancySensorType
  | typeof WaterLeakDetectorType
  | typeof SmokeAlarmType
  | typeof CoAlarmType
  | typeof OnOffSensorType;

const deviceClasses: Partial<Record<BinarySensorDeviceClass, CombinedType>> = {
  [BinarySensorDeviceClass.CarbonMonoxide]: CoAlarmType,
  [BinarySensorDeviceClass.Gas]: CoAlarmType,

  [BinarySensorDeviceClass.Battery]: ContactSensorType,
  [BinarySensorDeviceClass.BatteryCharging]: ContactSensorType,
  [BinarySensorDeviceClass.Cold]: ContactSensorType,
  [BinarySensorDeviceClass.Connectivity]: ContactSensorType,
  [BinarySensorDeviceClass.Door]: ContactSensorType,
  [BinarySensorDeviceClass.GarageDoor]: ContactSensorType,
  [BinarySensorDeviceClass.Heat]: ContactSensorType,
  [BinarySensorDeviceClass.Light]: ContactSensorType,
  [BinarySensorDeviceClass.Lock]: ContactSensorType,
  [BinarySensorDeviceClass.Opening]: ContactSensorType,
  [BinarySensorDeviceClass.Plug]: ContactSensorType,
  [BinarySensorDeviceClass.Power]: ContactSensorType,
  [BinarySensorDeviceClass.Problem]: ContactSensorType,
  [BinarySensorDeviceClass.Running]: ContactSensorType,
  [BinarySensorDeviceClass.Safety]: ContactSensorType,
  [BinarySensorDeviceClass.Sound]: ContactSensorType,
  [BinarySensorDeviceClass.Tamper]: ContactSensorType,
  [BinarySensorDeviceClass.Update]: ContactSensorType,
  [BinarySensorDeviceClass.Vibration]: ContactSensorType,
  [BinarySensorDeviceClass.Window]: ContactSensorType,

  [BinarySensorDeviceClass.Motion]: OccupancySensorType,
  [BinarySensorDeviceClass.Moving]: OccupancySensorType,
  [BinarySensorDeviceClass.Occupancy]: OccupancySensorType,
  [BinarySensorDeviceClass.Presence]: OccupancySensorType,

  [BinarySensorDeviceClass.Smoke]: SmokeAlarmType,

  [BinarySensorDeviceClass.Moisture]: WaterLeakDetectorType,
};

export function BinarySensorDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const defaultDeviceType = OnOffSensorType;

  const attributes = homeAssistantEntity.entity.state
    .attributes as BinarySensorDeviceAttributes;
  const deviceClass = attributes.device_class;
  const type =
    deviceClass && deviceClasses[deviceClass]
      ? deviceClasses[deviceClass]
      : defaultDeviceType;
  return type.set({ homeAssistantEntity });
}
