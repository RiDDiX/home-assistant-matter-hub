import {
  type BinarySensorDeviceAttributes,
  BinarySensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import type { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";

const logger = Logger.get("BinarySensorDevice");

import {
  ContactSensorType,
  ContactSensorWithBatteryType,
  DetectorContactSensorType,
} from "./contact-sensor.js";
import {
  MotionSensorType,
  MotionSensorWithBatteryType,
} from "./motion-sensor.js";
import {
  OccupancySensorType,
  OccupancySensorWithBatteryType,
} from "./occupancy-sensor.js";
import {
  OnOffSensorType,
  OnOffSensorWithBatteryType,
} from "./on-off-sensor.js";
import {
  CoAlarmType,
  CoAlarmWithBatteryType,
  SmokeAlarmType,
  SmokeAlarmWithBatteryType,
} from "./smoke-co-alarm.js";

type CombinedType =
  | typeof ContactSensorType
  | typeof DetectorContactSensorType
  | typeof MotionSensorType
  | typeof OccupancySensorType
  | typeof SmokeAlarmType
  | typeof CoAlarmType
  | typeof OnOffSensorType;

const deviceClasses: Partial<Record<BinarySensorDeviceClass, CombinedType>> = {
  [BinarySensorDeviceClass.CarbonMonoxide]: CoAlarmType,
  [BinarySensorDeviceClass.Gas]: CoAlarmType,

  [BinarySensorDeviceClass.BatteryCharging]: OnOffSensorType,
  [BinarySensorDeviceClass.Light]: OnOffSensorType,
  [BinarySensorDeviceClass.Plug]: OnOffSensorType,
  [BinarySensorDeviceClass.Power]: OnOffSensorType,
  [BinarySensorDeviceClass.Running]: OnOffSensorType,

  [BinarySensorDeviceClass.Battery]: ContactSensorType,
  [BinarySensorDeviceClass.Cold]: DetectorContactSensorType,
  [BinarySensorDeviceClass.Connectivity]: ContactSensorType,
  [BinarySensorDeviceClass.Door]: ContactSensorType,
  [BinarySensorDeviceClass.GarageDoor]: ContactSensorType,
  [BinarySensorDeviceClass.Heat]: ContactSensorType,
  [BinarySensorDeviceClass.Lock]: ContactSensorType,
  [BinarySensorDeviceClass.Opening]: ContactSensorType,
  [BinarySensorDeviceClass.Problem]: ContactSensorType,
  [BinarySensorDeviceClass.Safety]: ContactSensorType,
  [BinarySensorDeviceClass.Sound]: ContactSensorType,
  [BinarySensorDeviceClass.Tamper]: ContactSensorType,
  [BinarySensorDeviceClass.Update]: ContactSensorType,
  [BinarySensorDeviceClass.Vibration]: ContactSensorType,
  [BinarySensorDeviceClass.Window]: ContactSensorType,

  [BinarySensorDeviceClass.Motion]: MotionSensorType,
  [BinarySensorDeviceClass.Moving]: MotionSensorType,
  [BinarySensorDeviceClass.Occupancy]: OccupancySensorType,
  [BinarySensorDeviceClass.Presence]: OccupancySensorType,

  [BinarySensorDeviceClass.Smoke]: SmokeAlarmType,

  [BinarySensorDeviceClass.Moisture]: DetectorContactSensorType,
};

// Mapping from normal type to battery type
const batteryTypes = new Map<CombinedType, CombinedType>([
  [ContactSensorType, ContactSensorWithBatteryType],
  [MotionSensorType, MotionSensorWithBatteryType],
  [OccupancySensorType, OccupancySensorWithBatteryType],
  [OnOffSensorType, OnOffSensorWithBatteryType],
  [SmokeAlarmType, SmokeAlarmWithBatteryType],
  [CoAlarmType, CoAlarmWithBatteryType],
]);

export function BinarySensorDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const entityId = homeAssistantEntity.entity.entity_id;
  const defaultDeviceType = OnOffSensorType;

  const attributes = homeAssistantEntity.entity.state
    .attributes as BinarySensorDeviceAttributes & {
    battery?: number;
    battery_level?: number;
  };
  const deviceClass = attributes.device_class;
  const hasBatteryAttr =
    attributes.battery_level != null || attributes.battery != null;
  const hasBatteryEntity = !!homeAssistantEntity.mapping?.batteryEntity;
  const hasBattery = hasBatteryAttr || hasBatteryEntity;

  let type: CombinedType =
    deviceClass && deviceClasses[deviceClass]
      ? deviceClasses[deviceClass]
      : defaultDeviceType;

  const originalTypeName = type.name;

  // Use battery variant if available
  if (hasBattery && batteryTypes.has(type)) {
    type = batteryTypes.get(type)!;
    logger.info(
      `[${entityId}] Using battery variant: ${originalTypeName} -> ${type.name}, ` +
        `batteryAttr=${hasBatteryAttr}, batteryEntity=${homeAssistantEntity.mapping?.batteryEntity ?? "none"}`,
    );
  } else if (hasBattery) {
    logger.warn(
      `[${entityId}] Has battery but no variant available for ${originalTypeName}`,
    );
  }

  return type.set({ homeAssistantEntity });
}
