import {
  type CleanAreaRoom,
  type CustomServiceArea,
  type VacuumDeviceAttributes,
  VacuumDeviceFeature,
  VacuumState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import { ServiceAreaBehavior } from "@matter/main/behaviors";
import { RvcRunMode } from "@matter/main/clusters";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  type CleaningSession,
  getSession,
  RvcRunModeServer,
  RvcSupportedRunMode,
} from "../../../../behaviors/rvc-run-mode-server.js";
import {
  getRoomIdFromMode,
  getRoomModeValue,
  isDreameVacuum,
  isEcovacsVacuum,
  isRoborockVacuum,
  isXiaomiMiotVacuum,
  parseVacuumRooms,
  ROOM_MODE_BASE,
} from "../utils/parse-vacuum-rooms.js";
import { toAreaId } from "./vacuum-service-area-server.js";

const logger = Logger.get("VacuumRvcRunModeServer");

/**
 * Build an mqtt.publish action for Valetudo segment cleaning.
 * Valetudo uses MQTT (not vacuum.send_command) for segment-based cleaning.
 *
 * If valetudoIdentifier is set in the entity mapping, it is used directly.
 * Otherwise the identifier is extracted from the HA entity ID (lowercase).
 * HA normalizes entity IDs to lowercase, but the Valetudo MQTT topic uses
 * the original identifier case, set valetudoIdentifier in the mapping if
 * they don't match.
 */
function buildValetudoSegmentAction(
  vacuumEntityId: string,
  segmentIds: (string | number)[],
  valetudoIdentifier?: string,
) {
  const identifier =
    valetudoIdentifier || vacuumEntityId.replace(/^vacuum\.valetudo_/, "");
  const topic = `valetudo/${identifier}/MapSegmentationCapability/clean/set`;
  logger.info(
    `Valetudo: mqtt.publish to ${topic}, segments: ${segmentIds.join(", ")}`,
  );
  return {
    action: "mqtt.publish",
    target: false as const,
    data: {
      topic,
      payload: JSON.stringify({
        action: "start_segment_action",
        segment_ids: segmentIds.map(String),
        iterations: 1,
        customOrder: true,
      }),
    },
  };
}

/**
 * Build supported modes from vacuum attributes.
 * This includes base modes (Idle, Cleaning) plus room-specific modes if available.
 *
 * @param attributes - Vacuum device attributes
 * @param includeUnnamedRooms - If true, includes rooms with generic names like "Room 7". Default: false
 */
export function buildSupportedModes(
  attributes: VacuumDeviceAttributes,
  includeUnnamedRooms = false,
  customAreas?: CustomServiceArea[],
  disableRoomModes = false,
): RvcRunMode.ModeOption[] {
  const modes: RvcRunMode.ModeOption[] = [
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

  // Room modes in RvcRunMode are a fallback for controllers that don't use
  // ServiceArea.selectAreas. Apple Home does call selectAreas (see #317
  // logs), so both paths are registered and resolved independently.
  //
  // IMPORTANT: Sort rooms/areas alphabetically by name. Apple Home displays
  // modes sorted alphabetically but uses positional indexing into the
  // original mode array when calling changeToMode, so registration order
  // must match.

  if (customAreas && customAreas.length > 0) {
    // Custom service areas replace parsed rooms for mode generation.
    // Modes use ROOM_MODE_BASE + (1-based alphabetical index); cleanRoom
    // resolves them back the same way. ServiceArea areaIds instead follow
    // config order (createCustomServiceAreaServer), the two numbering
    // schemes are independent and resolved per path. When disableRoomModes is
    // set, skip them so the controller can only use ServiceArea (#367).
    if (!disableRoomModes) {
      const sorted = [...customAreas].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (let i = 0; i < sorted.length; i++) {
        const modeValue = ROOM_MODE_BASE + i + 1;
        if (modeValue > 255) continue;
        modes.push({
          label: sorted[i].name,
          mode: modeValue,
          modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }],
        });
      }
    }
  } else {
    // Regular room modes from vacuum attributes (Dreame, Roborock, etc.)
    const rooms = parseVacuumRooms(attributes, includeUnnamedRooms);
    rooms.sort((a, b) => a.name.localeCompare(b.name));
    for (const room of rooms) {
      const modeValue = getRoomModeValue(room);
      // Mode values must fit in uint8 (Matter spec: ModeBase mode is uint8)
      if (modeValue > 255) continue;
      modes.push({
        label: room.name,
        mode: modeValue,
        modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }],
      });
    }
  }

  return modes;
}

/**
 * Build the primary action for custom service areas and queue the rest
 * for sequential dispatch. Custom areas use 1-based IDs matching
 * createCustomServiceAreaServer.
 *
 * When any matched area has batchDispatch === true, a single combined call
 * is fired instead of sequential per-area calls (opt-in, for integrations
 * like Xiaomi Home that accept all room IDs in one call).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Combine the per-area values stored under one data key into a single batch
 * value, without ever dropping a room id:
 * - all equal: keep one
 * - all arrays: concatenate
 * - all plain objects: merge key by key (recurses, so nested room lists like
 *   data.params.segments are concatenated instead of collapsed to the first)
 * - all primitives: comma-join
 * - mixed array/scalar: flatten into one array (room ids survive)
 *
 * The previous else-branch returned values[0], which silently kept only the
 * first selected room when the room-bearing key was a nested object or a
 * mixed array/scalar (#367).
 */
function mergeBatchValues(values: unknown[]): unknown {
  if (values.length === 1) {
    return values[0];
  }
  if (
    values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))
  ) {
    return values[0];
  }
  if (values.every(Array.isArray)) {
    return values.flat();
  }
  if (values.every(isPlainObject)) {
    const keys = new Set(values.flatMap((value) => Object.keys(value)));
    const merged: Record<string, unknown> = {};
    for (const key of keys) {
      const nested = values
        .map((value) => value[key])
        .filter((value) => value !== undefined);
      if (nested.length > 0) {
        merged[key] = mergeBatchValues(nested);
      }
    }
    return merged;
  }
  if (
    values.every(
      (value) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    )
  ) {
    return values.join(",");
  }
  // Mixed array/scalar (or otherwise incompatible): flatten into one array so
  // every room id is preserved instead of dropping all but the first.
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

function mergeBatchData(areas: CustomServiceArea[]) {
  const dataEntries = areas.map((area) => area.data ?? {});
  const keys = new Set(dataEntries.flatMap((data) => Object.keys(data)));
  const data: Record<string, unknown> = {};

  for (const key of keys) {
    const values = dataEntries
      .map((entry) => entry[key])
      .filter((value) => value !== undefined);

    if (values.length === 0) continue;
    data[key] = mergeBatchValues(values);
  }

  return data;
}

export function handleCustomServiceAreas(
  selectedAreas: number[],
  customAreas: CustomServiceArea[],
  session: CleaningSession,
) {
  const matched = selectedAreas
    .map((areaId) => ({ areaId, area: customAreas[areaId - 1] }))
    .filter((m): m is { areaId: number; area: CustomServiceArea } => !!m.area);

  if (matched.length === 0) {
    logger.warn(
      `Custom service areas: no match for selected IDs ${selectedAreas.join(", ")}`,
    );
    return { action: "vacuum.start" };
  }

  // Batch dispatch: one call for all selected areas, injecting combined data.
  const batchArea = matched.find(({ area }) => area.batchDispatch === true);
  if (batchArea) {
    logger.info(
      `Custom service areas (batch): single call for ${matched.length} room(s): ${matched.map(({ area }) => area.name).join(", ")}`,
    );
    session.pendingDispatches = [];
    const template = batchArea.area;
    const areas = matched.map(({ area }) => area);
    const areaIds = matched.map(({ areaId }) => areaId);
    const areaNames = matched.map(({ area }) => area.name);
    return {
      action: template.service,
      target: template.target,
      data: {
        ...mergeBatchData(areas),
        selected_area_ids: areaIds,
        selected_area_ids_csv: areaIds.join(","),
        selected_area_names: areaNames,
        selected_area_names_csv: areaNames.join(","),
        selected_area_data: areas.map((area) => area.data ?? {}),
      },
    };
  }

  logger.info(
    `Custom service areas: ${matched.length} room(s) queued: ${matched.map(({ area }) => `${area.service} (${area.name})`).join(", ")}`,
  );

  // Queue rest; the first action is fired by the caller.
  session.pendingDispatches = matched.slice(1).map(({ areaId, area }) => ({
    areaId,
    action: { action: area.service, target: area.target, data: area.data },
  }));

  const first = matched[0].area;
  return {
    action: first.service,
    target: first.target,
    data: first.data,
  };
}

/**
 * Resolve Matter ServiceArea area IDs to HA area_id strings using CLEAN_AREA mapping.
 */
function resolveCleanAreaIds(
  selectedAreas: number[],
  cleanAreaRooms: CleanAreaRoom[],
): string[] {
  const haAreaIds: string[] = [];
  for (const areaId of selectedAreas) {
    const room = cleanAreaRooms.find((r) => r.areaId === areaId);
    if (room) {
      haAreaIds.push(room.haAreaId);
    }
  }
  return haAreaIds;
}

// All cleaning-related states map to Cleaning mode. "paused" is included
// because in HA it means paused mid-clean; the Matter spec requires Cleaning
// mode when OpState is Paused. Shared with VacuumOnOffServer.isOn (#428).
const cleaningStates: string[] = [
  VacuumState.cleaning,
  VacuumState.segment_cleaning,
  VacuumState.zone_cleaning,
  VacuumState.spot_cleaning,
  VacuumState.mop_cleaning,
  VacuumState.paused,
];

export function vacuumIsCleaning(state: string | undefined): boolean {
  return state != null && cleaningStates.includes(state);
}

const vacuumRvcRunModeConfig = {
  getCurrentMode: (entity: { state: string }) => {
    const isCleaning = vacuumIsCleaning(entity.state);
    logger.debug(
      `Vacuum state: "${entity.state}", isCleaning: ${isCleaning}, currentMode: ${isCleaning ? "Cleaning" : "Idle"}`,
    );
    return isCleaning ? RvcSupportedRunMode.Cleaning : RvcSupportedRunMode.Idle;
  },

  getSupportedModes: (entity: { attributes: unknown }, agent: Agent) => {
    const attributes = entity.attributes as VacuumDeviceAttributes;
    const mapping = agent.get(HomeAssistantEntityBehavior).state.mapping;
    const customAreas = mapping?.customServiceAreas;
    return buildSupportedModes(
      attributes,
      false,
      customAreas && customAreas.length > 0 ? customAreas : undefined,
      mapping?.disableCustomAreaRoomModes,
    );
  },

  // biome-ignore lint/suspicious/noConfusingVoidType: Required by ValueSetter<void> interface
  start: (_: void, agent: Agent) => {
    // Check if there are selected areas from ServiceArea
    try {
      const serviceArea = agent.get(ServiceAreaBehavior);
      // IMPORTANT: Snapshot-copy the array. Matter.js managed state
      // returns proxied arrays; clearing the state later would
      // invalidate a live reference (Datasource subref refresh).
      const selectedAreas = [...serviceArea.state.selectedAreas];

      if (selectedAreas.length > 0) {
        const homeAssistant = agent.get(HomeAssistantEntityBehavior);
        const entity = homeAssistant.entity;
        const attributes = entity.state.attributes as VacuumDeviceAttributes;
        const session = getSession(homeAssistant.endpoint);

        // Check for user-defined custom service areas first (lawn mowers, generic zone robots)
        const customAreas = homeAssistant.state.mapping?.customServiceAreas;
        if (customAreas && customAreas.length > 0) {
          return handleCustomServiceAreas(selectedAreas, customAreas, session);
        }

        // HA 2026.3 CLEAN_AREA: resolve selected ServiceArea IDs to HA area IDs
        const cleanAreaRooms = homeAssistant.state.mapping?.cleanAreaRooms;
        if (cleanAreaRooms && cleanAreaRooms.length > 0) {
          const haAreaIds = resolveCleanAreaIds(selectedAreas, cleanAreaRooms);
          if (haAreaIds.length > 0) {
            logger.info(
              `CLEAN_AREA: cleaning HA areas: ${haAreaIds.join(", ")}`,
            );
            return {
              action: "vacuum.clean_area",
              data: { cleaning_area_id: haAreaIds },
            };
          }
        }

        // Roborock button entities: each press triggers app_segment_clean
        // for one segment, so they need the same one-at-a-time dispatch.
        const roomEntities = homeAssistant.state.mapping?.roomEntities;
        if (roomEntities && roomEntities.length > 0) {
          const matched: { areaId: number; entityId: string }[] = [];
          for (const areaId of selectedAreas) {
            const entityId = roomEntities.find((id) => toAreaId(id) === areaId);
            if (entityId) {
              matched.push({ areaId, entityId });
            }
          }

          if (matched.length > 0) {
            logger.info(
              `Roborock: ${matched.length} room button(s) queued: ${matched.map((m) => m.entityId).join(", ")}`,
            );

            session.pendingDispatches = matched
              .slice(1)
              .map(({ areaId, entityId }) => ({
                areaId,
                action: { action: "button.press", target: entityId },
              }));

            return {
              action: "button.press",
              target: matched[0].entityId,
            };
          }
        }

        // Valetudo vacuums: rooms come from sensor.*_map_segments (injected
        // at creation time), not from the vacuum entity's live attributes.
        // parseVacuumRooms() would return [] at runtime. Use selectedAreas
        // directly as segment IDs since toAreaId(numericId) === numericId.
        const vacuumEntityId = homeAssistant.entityId;
        if (vacuumEntityId.startsWith("vacuum.valetudo_")) {
          return buildValetudoSegmentAction(
            vacuumEntityId,
            selectedAreas,
            homeAssistant.state.mapping?.valetudoIdentifier,
          );
        }

        // Fallback: Try to find rooms from vacuum attributes (Dreame, Xiaomi Miot)
        const rooms = parseVacuumRooms(attributes);

        // Convert area IDs back to room IDs
        // Use originalId if available (Dreame multi-floor: id is deduplicated, originalId is per-floor)
        const roomIds: (string | number)[] = [];
        let targetMapName: string | undefined;
        for (const areaId of selectedAreas) {
          const room = rooms.find((r) => toAreaId(r.id) === areaId);
          if (room) {
            roomIds.push(room.originalId ?? room.id);
            if (room.mapName && !targetMapName) {
              targetMapName = room.mapName;
            }
          }
        }

        if (roomIds.length > 0) {
          logger.info(
            `Starting cleaning with selected areas: ${roomIds.join(", ")}`,
          );

          // Dreame vacuums use their own service
          if (isDreameVacuum(attributes)) {
            // Switch to correct floor before cleaning (multi-floor Dreame)
            if (targetMapName) {
              const vacName = vacuumEntityId.replace("vacuum.", "");
              const selectedMapEntity = `select.${vacName}_selected_map`;
              logger.info(
                `Dreame multi-floor: switching to map "${targetMapName}" via ${selectedMapEntity}`,
              );
              homeAssistant.callAction({
                action: "select.select_option",
                target: selectedMapEntity,
                data: { option: targetMapName },
              });
            }
            return {
              action: "dreame_vacuum.vacuum_clean_segment",
              data: {
                segments: roomIds.length === 1 ? roomIds[0] : roomIds,
              },
            };
          }

          // Roborock/Xiaomi Miot vacuums use vacuum.send_command with app_segment_clean
          if (isRoborockVacuum(attributes) || isXiaomiMiotVacuum(attributes)) {
            return {
              action: "vacuum.send_command",
              data: {
                command: "app_segment_clean",
                params: roomIds,
              },
            };
          }

          // Ecovacs/Deebot vacuums use vacuum.send_command with spot_area
          // Params must be a dict (not a list) with comma-separated room IDs as string
          if (isEcovacsVacuum(attributes)) {
            const roomIdStr = roomIds.join(",");
            logger.info(
              `Ecovacs vacuum: Using spot_area for rooms: ${roomIdStr}`,
            );
            return {
              action: "vacuum.send_command",
              data: {
                command: "spot_area",
                params: {
                  mapID: 0,
                  cleanings: 1,
                  rooms: roomIdStr,
                },
              },
            };
          }

          // Unknown vacuum type - fall back to regular start.
          // app_segment_clean is Roborock-specific and will fail on other
          // integrations (e.g. Ecovacs/Deebot rejects list params).
          logger.warn(
            `Room cleaning via send_command not supported for this vacuum type. Rooms: ${roomIds.join(", ")}. Falling back to vacuum.start`,
          );
        }
      }
    } catch {
      // ServiceArea not available, fall through to regular start
    }

    logger.info("Starting regular cleaning (no areas selected)");
    return { action: "vacuum.start" };
  },
  returnToBase: () => ({ action: "vacuum.return_to_base" }),
  pause: (
    // biome-ignore lint/suspicious/noConfusingVoidType: Required by ValueSetter<void> interface
    _: void,
    agent: {
      get: (
        type: typeof HomeAssistantEntityBehavior,
      ) => HomeAssistantEntityBehavior;
    },
  ) => {
    const supportedFeatures =
      agent.get(HomeAssistantEntityBehavior).entity.state.attributes
        .supported_features ?? 0;
    if (testBit(supportedFeatures, VacuumDeviceFeature.PAUSE)) {
      return { action: "vacuum.pause" };
    }
    return { action: "vacuum.stop" };
  },

  cleanRoom: (
    roomMode: number,
    agent: {
      get: (
        type: typeof HomeAssistantEntityBehavior,
      ) => HomeAssistantEntityBehavior;
    },
  ) => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const entity = homeAssistant.entity;
    const attributes = entity.state.attributes as VacuumDeviceAttributes;

    logger.info(`cleanRoom called: roomMode=${roomMode}`);

    // HA 2026.3 CLEAN_AREA: resolve room mode to HA area ID
    const cleanAreaRooms = homeAssistant.state.mapping?.cleanAreaRooms;
    if (cleanAreaRooms && cleanAreaRooms.length > 0) {
      const sorted = [...cleanAreaRooms].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const areaIndex = roomMode - ROOM_MODE_BASE - 1;
      if (areaIndex >= 0 && areaIndex < sorted.length) {
        const area = sorted[areaIndex];
        logger.info(
          `cleanRoom: CLEAN_AREA "${area.name}" → vacuum.clean_area(${area.haAreaId})`,
        );
        return {
          action: "vacuum.clean_area",
          data: { cleaning_area_id: [area.haAreaId] },
        };
      }
    }

    // Handle user-defined custom service areas first (lawn mowers, generic zone robots).
    // Mode values for custom areas: ROOM_MODE_BASE + (1-based sorted index).
    const customAreas = homeAssistant.state.mapping?.customServiceAreas;
    if (customAreas && customAreas.length > 0) {
      const sorted = [...customAreas].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const areaIndex = roomMode - ROOM_MODE_BASE - 1;
      if (areaIndex >= 0 && areaIndex < sorted.length) {
        const area = sorted[areaIndex];
        logger.info(
          `cleanRoom: custom service area "${area.name}" → ${area.service}`,
        );
        return {
          action: area.service,
          target: area.target,
          data: area.data,
        };
      }
    }

    // Valetudo vacuums: rooms come from sensor.*_map_segments (injected
    // at creation time), not from the vacuum entity's live attributes.
    // parseVacuumRooms() would return [] at runtime. The segment ID equals
    // roomMode - ROOM_MODE_BASE since toAreaId(numericId) === numericId.
    const vacuumEntityId = entity.entity_id;
    if (vacuumEntityId.startsWith("vacuum.valetudo_")) {
      const segmentId = getRoomIdFromMode(roomMode);
      return buildValetudoSegmentAction(
        vacuumEntityId,
        [segmentId],
        homeAssistant.state.mapping?.valetudoIdentifier,
      );
    }

    // Regular room handling from vacuum attributes (Dreame, Roborock, etc.)
    const rooms = parseVacuumRooms(attributes);
    const numericIdFromMode = getRoomIdFromMode(roomMode);

    logger.info(
      `cleanRoom: numericIdFromMode=${numericIdFromMode}, available rooms: ${JSON.stringify(rooms.map((r) => ({ id: r.id, name: r.name, modeValue: getRoomModeValue(r) })))}`,
    );

    // Find the room by matching mode value (ensures consistency)
    const room = rooms.find((r) => getRoomModeValue(r) === roomMode);

    if (room) {
      // Use originalId for commands (Dreame multi-floor: id is deduplicated, originalId is per-floor)
      const commandId = room.originalId ?? room.id;

      // Dreame vacuums use their own service: dreame_vacuum.vacuum_clean_segment
      if (isDreameVacuum(attributes)) {
        // Switch to correct floor before cleaning (multi-floor Dreame)
        if (room.mapName) {
          const vacuumName = vacuumEntityId.replace("vacuum.", "");
          const selectedMapEntity = `select.${vacuumName}_selected_map`;
          logger.info(
            `Dreame multi-floor: switching to map "${room.mapName}" via ${selectedMapEntity}`,
          );
          homeAssistant.callAction({
            action: "select.select_option",
            target: selectedMapEntity,
            data: { option: room.mapName },
          });
        }
        logger.debug(
          `Dreame vacuum detected, using dreame_vacuum.vacuum_clean_segment for room ${room.name} (commandId: ${commandId}, id: ${room.id})`,
        );
        return {
          action: "dreame_vacuum.vacuum_clean_segment",
          data: {
            segments: commandId,
          },
        };
      }

      // Roborock/Xiaomi Miot vacuums use vacuum.send_command with app_segment_clean
      if (isRoborockVacuum(attributes) || isXiaomiMiotVacuum(attributes)) {
        logger.debug(
          `Using vacuum.send_command with app_segment_clean for room ${room.name} (commandId: ${commandId}, id: ${room.id})`,
        );
        return {
          action: "vacuum.send_command",
          data: {
            command: "app_segment_clean",
            params: [commandId],
          },
        };
      }

      // Ecovacs/Deebot vacuums use vacuum.send_command with spot_area
      if (isEcovacsVacuum(attributes)) {
        const roomIdStr = String(commandId);
        logger.info(
          `Ecovacs vacuum: Using spot_area for room ${room.name} (id: ${roomIdStr})`,
        );
        return {
          action: "vacuum.send_command",
          data: {
            command: "spot_area",
            params: {
              mapID: 0,
              cleanings: 1,
              rooms: roomIdStr,
            },
          },
        };
      }

      // Unknown vacuum type - fall back to regular start
      logger.warn(
        `Room cleaning via send_command not supported for this vacuum type. Room: ${room.name} (id=${commandId}). Falling back to vacuum.start`,
      );
    }
    return { action: "vacuum.start" };
  },
};

/**
 * Create a VacuumRvcRunModeServer with initial supportedModes.
 * The modes MUST be provided at creation time for Matter.js initialization.
 *
 * @param attributes - Vacuum device attributes
 * @param includeUnnamedRooms - If true, includes rooms with generic names like "Room 7". Default: false
 */
export function createVacuumRvcRunModeServer(
  attributes: VacuumDeviceAttributes,
  includeUnnamedRooms = false,
  customAreas?: CustomServiceArea[],
  disableRoomModes = false,
) {
  // Get all rooms first for logging
  const allRooms = parseVacuumRooms(attributes, true);
  const rooms = includeUnnamedRooms
    ? allRooms
    : parseVacuumRooms(attributes, false);
  const filteredCount = allRooms.length - rooms.length;

  const supportedModes = buildSupportedModes(
    attributes,
    includeUnnamedRooms,
    customAreas,
    disableRoomModes,
  );

  logger.info(
    `Creating VacuumRvcRunModeServer with ${rooms.length} rooms, ${supportedModes.length} total modes`,
  );
  if (rooms.length > 0) {
    logger.info(`Rooms found: ${rooms.map((r) => r.name).join(", ")}`);
  }
  if (filteredCount > 0) {
    const filtered = allRooms.filter((r) => !rooms.some((x) => x.id === r.id));
    logger.info(
      `Filtered out ${filteredCount} unnamed room(s): ${filtered.map((r) => r.name).join(", ")}`,
    );
  }
  if (allRooms.length === 0) {
    logger.debug(
      `No rooms found. Attributes: rooms=${JSON.stringify(attributes.rooms)}, segments=${JSON.stringify(attributes.segments)}, room_list=${attributes.room_list}`,
    );
  }

  return RvcRunModeServer(vacuumRvcRunModeConfig, {
    supportedModes,
    currentMode: RvcSupportedRunMode.Idle,
  });
}

/**
 * Create a VacuumRvcRunModeServer with HA areas from CLEAN_AREA mapping.
 * Room modes are generated from the HA areas so Apple Home (which doesn't use
 * ServiceArea.selectAreas) can still trigger per-area cleaning.
 */
export function createCleanAreaRvcRunModeServer(
  cleanAreaRooms: CleanAreaRoom[],
) {
  const modes: RvcRunMode.ModeOption[] = [
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

  const sorted = [...cleanAreaRooms].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (let i = 0; i < sorted.length; i++) {
    const modeValue = ROOM_MODE_BASE + i + 1;
    if (modeValue > 255) continue;
    modes.push({
      label: sorted[i].name,
      mode: modeValue,
      modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }],
    });
  }

  logger.info(
    `Creating CLEAN_AREA RvcRunModeServer with ${cleanAreaRooms.length} HA areas, ${modes.length} total modes`,
  );

  return RvcRunModeServer(vacuumRvcRunModeConfig, {
    supportedModes: modes,
    currentMode: RvcSupportedRunMode.Idle,
  });
}
