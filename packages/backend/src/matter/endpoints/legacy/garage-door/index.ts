import type { EndpointType } from "@matter/main";
import { DoorLock } from "@matter/main/clusters";
import { DoorLockDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import {
  LockServer,
  type LockServerConfig,
} from "../../../behaviors/lock-server.js";

// Map cover states to door lock states
// Open garage = Unlocked, Closed garage = Locked
const mapCoverState: Record<string, DoorLock.LockState> = {
  open: DoorLock.LockState.Unlocked,
  opening: DoorLock.LockState.Unlocked,
  closed: DoorLock.LockState.Locked,
  closing: DoorLock.LockState.Locked,
};

const garageDoorServerConfig: LockServerConfig = {
  getLockState: (entity) =>
    mapCoverState[entity.state] ?? DoorLock.LockState.NotFullyLocked,
  // "Lock" the garage = close it
  lock: () => ({ action: "cover.close_cover" }),
  // "Unlock" the garage = open it
  unlock: () => ({ action: "cover.open_cover" }),
};

// Use DoorLockDevice which has deviceType 0x000A (10)
// This is the same as GarageDoorOpener and will be recognized by Apple CarPlay
const GarageDoorDeviceType = DoorLockDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  LockServer(garageDoorServerConfig),
);

export function GarageDoorDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return GarageDoorDeviceType.set({ homeAssistantEntity });
}
