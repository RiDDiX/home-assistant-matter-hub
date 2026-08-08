import {
  type LockDeviceAttributes,
  LockSupportedFeatures,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { DoorLock } from "@matter/main/clusters";
import { DoorLockDevice } from "@matter/main/devices";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import {
  type LockServerConfig,
  LockServerWithPin,
  LockServerWithPinAndUnbolt,
} from "../../../behaviors/lock-server.js";
import { DefaultPowerSourceServer } from "../../../behaviors/power-source-server.js";

const mapHAState: Record<string, DoorLock.LockState> = {
  locked: DoorLock.LockState.Locked,
  locking: DoorLock.LockState.Locked,
  unlocked: DoorLock.LockState.Unlocked,
  unlocking: DoorLock.LockState.Unlocked,
  open: DoorLock.LockState.Unlatched,
  opening: DoorLock.LockState.Unlatched,
};

const lockServerConfig: LockServerConfig = {
  getLockState: (entity) =>
    mapHAState[entity.state] ?? DoorLock.LockState.NotFullyLocked,
  lock: () => ({ action: "lock.lock" }),
  unlock: () => ({ action: "lock.unlock" }),
  unlatch: () => ({ action: "lock.open" }),
};

// Lock without battery or unlatch
const LockDeviceType = DoorLockDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  LockServerWithPin(lockServerConfig),
);

// Lock with battery (no unlatch)
const LockWithBatteryDeviceType = DoorLockDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  LockServerWithPin(lockServerConfig),
  DefaultPowerSourceServer,
);

// Lock with unlatch (Unbolting feature) - for locks supporting HA's OPEN feature
// Apple Home shows an "Unlatch" button when this is present
const LockWithUnlatchDeviceType = DoorLockDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  LockServerWithPinAndUnbolt(lockServerConfig),
);

// Lock with unlatch + battery
const LockWithUnlatchAndBatteryDeviceType = DoorLockDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  LockServerWithPinAndUnbolt(lockServerConfig),
  DefaultPowerSourceServer,
);

export function LockDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attrs = homeAssistantEntity.entity.state
    .attributes as LockDeviceAttributes & {
    battery?: number;
    battery_level?: number;
  };
  const hasBatteryAttr = attrs.battery_level != null || attrs.battery != null;
  const hasBatteryEntity = !!homeAssistantEntity.mapping?.batteryEntity;
  const hasBattery = hasBatteryAttr || hasBatteryEntity;

  // Check if the lock supports the OPEN feature (unlatch/unbolt)
  const supportsUnlatch = testBit(
    attrs.supported_features ?? 0,
    LockSupportedFeatures.support_open,
  );

  if (supportsUnlatch && hasBattery) {
    return LockWithUnlatchAndBatteryDeviceType.set({ homeAssistantEntity });
  }
  if (supportsUnlatch) {
    return LockWithUnlatchDeviceType.set({ homeAssistantEntity });
  }
  if (hasBattery) {
    return LockWithBatteryDeviceType.set({ homeAssistantEntity });
  }
  return LockDeviceType.set({ homeAssistantEntity });
}
