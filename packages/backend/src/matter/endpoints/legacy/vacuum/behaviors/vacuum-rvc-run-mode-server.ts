import {
  type VacuumDeviceAttributes,
  VacuumDeviceFeature,
  VacuumState,
} from "@home-assistant-matter-hub/common";
import { RvcRunMode } from "@matter/main/clusters";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  RvcRunModeServer,
  RvcSupportedRunMode,
} from "../../../../behaviors/rvc-run-mode-server.js";
import {
  getRoomIndexFromMode,
  getRoomModeValue,
  parseVacuumRooms,
} from "../utils/parse-vacuum-rooms.js";

export const VacuumRvcRunModeServer = RvcRunModeServer({
  getCurrentMode: (entity) =>
    [VacuumState.cleaning].includes(entity.state as VacuumState)
      ? RvcSupportedRunMode.Cleaning
      : RvcSupportedRunMode.Idle,

  getSupportedModes: (entity) => {
    const baseModes: RvcRunMode.ModeOption[] = [
      {
        label: "Idle",
        mode: RvcSupportedRunMode.Idle,
        modeTags: [{ value: RvcRunMode.ModeTag.Idle }],
      },
      {
        label: "Cleaning",
        mode: RvcSupportedRunMode.Cleaning,
        modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }],
      },
    ];

    const attributes = entity.attributes as VacuumDeviceAttributes;
    const rooms = parseVacuumRooms(attributes);

    if (rooms.length > 0) {
      for (let i = 0; i < rooms.length; i++) {
        const room = rooms[i];
        baseModes.push({
          label: `Clean ${room.name}`,
          mode: getRoomModeValue(i),
          modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }],
        });
      }
    }

    return baseModes;
  },

  start: () => ({ action: "vacuum.start" }),
  returnToBase: () => ({ action: "vacuum.return_to_base" }),
  pause: (_, agent) => {
    const supportedFeatures =
      agent.get(HomeAssistantEntityBehavior).entity.state.attributes
        .supported_features ?? 0;
    if (testBit(supportedFeatures, VacuumDeviceFeature.PAUSE)) {
      return { action: "vacuum.pause" };
    }
    return { action: "vacuum.stop" };
  },

  cleanRoom: (roomMode: number, agent) => {
    const entity = agent.get(HomeAssistantEntityBehavior).entity;
    const attributes = entity.state.attributes as VacuumDeviceAttributes;
    const rooms = parseVacuumRooms(attributes);
    const roomIndex = getRoomIndexFromMode(roomMode);

    if (roomIndex >= 0 && roomIndex < rooms.length) {
      const room = rooms[roomIndex];
      return {
        action: "vacuum.send_command",
        data: {
          command: "app_segment_clean",
          params: [room.id],
        },
      };
    }
    return { action: "vacuum.start" };
  },
});
