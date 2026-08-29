import type {
  EntityMappingConfig,
  HomeAssistantEntityState,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import debounce from "debounce";
import type { BridgeRegistry } from "../../services/bridges/bridge-registry.js";
import type { HomeAssistantStates } from "../../services/home-assistant/home-assistant-registry.js";
import { EntityEndpoint, getMappedEntityIds } from "./entity-endpoint.js";
import { supportsCleaningModes } from "./legacy/vacuum/behaviors/vacuum-rvc-clean-mode-server.js";
import { ServerModeVacuumDevice } from "./legacy/vacuum/server-mode-vacuum-device.js";
import { updateEntityState } from "./update-entity-state.js";

const logger = Logger.get("ServerModeVacuumEndpoint");

/**
 * Server Mode Vacuum Endpoint.
 *
 * This endpoint does NOT include BridgedDeviceBasicInformationServer,
 * making it appear as a standalone Matter device rather than a bridged device.
 * This is required for Apple Home Siri voice commands and Alexa discovery.
 */
export class ServerModeVacuumEndpoint extends EntityEndpoint {
  public static async create(
    registry: BridgeRegistry,
    entityId: string,
    mapping?: EntityMappingConfig,
    endpointId?: string,
  ): Promise<ServerModeVacuumEndpoint | undefined> {
    const deviceRegistry = registry.deviceOf(entityId);
    let state = registry.initialState(entityId);
    const entity = registry.entity(entityId);

    if (!state) {
      return undefined;
    }

    // Auto-assign battery entity if not manually set
    let effectiveMapping = mapping;
    // disableBatteryMapping wins over a manual batteryEntity too, matching the
    // legacy and user-composed paths (#427).
    if (mapping?.disableBatteryMapping && mapping.batteryEntity) {
      effectiveMapping = { ...mapping, batteryEntity: undefined };
    }
    logger.info(
      `${entityId}: device_id=${entity.device_id}, manualBattery=${mapping?.batteryEntity ?? "none"}`,
    );
    if (entity.device_id) {
      if (!mapping?.batteryEntity && !mapping?.disableBatteryMapping) {
        const batteryEntityId = registry.findBatteryEntityForDevice(
          entity.device_id,
        );
        if (batteryEntityId && batteryEntityId !== entityId) {
          effectiveMapping = {
            ...effectiveMapping,
            entityId: effectiveMapping?.entityId ?? entityId,
            batteryEntity: batteryEntityId,
          };
          registry.markBatteryEntityUsed(batteryEntityId);
          logger.info(`${entityId}: Auto-assigned battery ${batteryEntityId}`);
        } else {
          const attrs = state.attributes as VacuumDeviceAttributes;
          if (attrs.battery_level != null || attrs.battery != null) {
            logger.info(
              `${entityId}: No battery entity found, using battery attribute from vacuum state`,
            );
          } else {
            logger.warn(
              `${entityId}: No battery entity found for device ${entity.device_id}`,
            );
          }
        }
      }

      // Auto-detect vacuum select entities (cleaning mode, suction, mop intensity)
      const vacuumEntities = registry.findVacuumSelectEntities(
        entity.device_id,
      );
      if (
        !effectiveMapping?.cleaningModeEntity &&
        vacuumEntities.cleaningModeEntity
      ) {
        effectiveMapping = {
          ...effectiveMapping,
          entityId: effectiveMapping?.entityId ?? entityId,
          cleaningModeEntity: vacuumEntities.cleaningModeEntity,
        };
        logger.info(
          `${entityId}: Auto-assigned cleaningMode ${vacuumEntities.cleaningModeEntity}`,
        );
      }
      if (
        !effectiveMapping?.suctionLevelEntity &&
        vacuumEntities.suctionLevelEntity
      ) {
        effectiveMapping = {
          ...effectiveMapping,
          entityId: effectiveMapping?.entityId ?? entityId,
          suctionLevelEntity: vacuumEntities.suctionLevelEntity,
        };
        logger.info(
          `${entityId}: Auto-assigned suctionLevel ${vacuumEntities.suctionLevelEntity}`,
        );
      }
      if (
        !effectiveMapping?.mopIntensityEntity &&
        vacuumEntities.mopIntensityEntity
      ) {
        effectiveMapping = {
          ...effectiveMapping,
          entityId: effectiveMapping?.entityId ?? entityId,
          mopIntensityEntity: vacuumEntities.mopIntensityEntity,
        };
        logger.info(
          `${entityId}: Auto-assigned mopIntensity ${vacuumEntities.mopIntensityEntity}`,
        );
      }
      if (
        !effectiveMapping?.currentRoomEntity &&
        vacuumEntities.currentRoomEntity
      ) {
        effectiveMapping = {
          ...effectiveMapping,
          entityId: effectiveMapping?.entityId ?? entityId,
          currentRoomEntity: vacuumEntities.currentRoomEntity,
        };
        logger.info(
          `${entityId}: Auto-assigned currentRoom ${vacuumEntities.currentRoomEntity}`,
        );
      }

      // HA 2026.3 CLEAN_AREA: resolve HA area mapping before vendor-specific room detection.
      // When CLEAN_AREA is supported and area_mapping is configured, this takes priority
      // over all vendor-specific room detection methods.
      const supportedFeatures =
        (state.attributes as VacuumDeviceAttributes).supported_features ?? 0;
      const cleanAreaRooms = await registry.resolveCleanAreaRooms(
        entityId,
        supportedFeatures,
      );
      if (cleanAreaRooms.length > 0) {
        effectiveMapping = {
          ...effectiveMapping,
          entityId: effectiveMapping?.entityId ?? entityId,
          cleanAreaRooms,
        };
        logger.info(
          `${entityId}: Using ${cleanAreaRooms.length} HA areas via CLEAN_AREA`,
        );
      }

      // Auto-detect rooms when no rooms in attributes and no CLEAN_AREA mapping
      const vacAttrs = state.attributes as VacuumDeviceAttributes;
      if (
        cleanAreaRooms.length === 0 &&
        !vacAttrs.rooms &&
        !vacAttrs.segments &&
        !vacAttrs.room_mapping
      ) {
        // Try Valetudo map segments sensor (sensor.*_map_segments on same device)
        const valetudoRooms = registry.findValetudoMapSegments(
          entity.device_id,
        );
        if (valetudoRooms.length > 0) {
          const roomsObj: Record<string, string> = {};
          for (const r of valetudoRooms) {
            roomsObj[String(r.id)] = r.name;
          }
          state = {
            ...state,
            attributes: {
              ...state.attributes,
              rooms: roomsObj,
            } as typeof state.attributes,
          };
          logger.info(
            `${entityId}: Auto-detected ${valetudoRooms.length} Valetudo segments`,
          );
        } else {
          // Try Roborock integration service call
          const roborockRooms = await registry.resolveRoborockRooms(entityId);
          if (roborockRooms.length > 0) {
            const roomsObj: Record<string, string> = {};
            for (const r of roborockRooms) {
              roomsObj[String(r.id)] = r.name;
            }
            state = {
              ...state,
              attributes: {
                ...state.attributes,
                rooms: roomsObj,
              } as typeof state.attributes,
            };
            logger.info(
              `${entityId}: Auto-detected ${roborockRooms.length} Roborock rooms`,
            );
          }
        }
      }
    } else {
      logger.warn(`${entityId}: No device_id, cannot auto-assign battery`);
    }

    const payload = {
      entity_id: entityId,
      state,
      registry: entity,
      deviceRegistry,
    };

    // Resolve cleaning mode options for accurate RvcCleanMode generation.
    // Reads actual entity options so only supported types get modes.
    const vacAttrsForClean = state.attributes as VacuumDeviceAttributes;
    let cleaningModeOptions: string[] | undefined;
    if (effectiveMapping?.cleaningModeEntity) {
      const cmState = registry.initialState(
        effectiveMapping.cleaningModeEntity,
      );
      cleaningModeOptions = (
        cmState?.attributes as { options?: string[] } | undefined
      )?.options;
    }
    // Fallback: if no options from entity (unavailable / not loaded),
    // use hardcoded defaults so mop modes are still generated.
    // The runtime getCurrentMode/setCleanMode reads the entity live.
    if (
      !cleaningModeOptions &&
      (effectiveMapping?.cleaningModeEntity ||
        supportsCleaningModes(vacAttrsForClean))
    ) {
      cleaningModeOptions = [
        "vacuum",
        "mop",
        "vacuum_and_mop",
        "vacuum_then_mop",
      ];
    }

    const customName = effectiveMapping?.customName;
    const endpointType = ServerModeVacuumDevice(
      {
        entity: payload,
        customName,
        mapping: effectiveMapping,
      },
      registry.isServerModeVacuumOnOffEnabled(),
      cleaningModeOptions,
    );

    if (!endpointType) {
      return undefined;
    }

    const mappedIds = getMappedEntityIds(effectiveMapping);
    return new ServerModeVacuumEndpoint(
      endpointType,
      entityId,
      customName,
      mappedIds,
      endpointId,
    );
  }

  private lastState?: HomeAssistantEntityState;
  private pendingMappedChange = false;
  private readonly flushUpdate: ReturnType<typeof debounce>;

  private constructor(
    type: EndpointType,
    entityId: string,
    customName?: string,
    mappedEntityIds?: string[],
    endpointId?: string,
  ) {
    super(type, entityId, customName, mappedEntityIds, endpointId);
    // Debounce state updates to batch rapid changes into a single transaction.
    // HA sends vacuum state updates every 5-10s even when unchanged.
    // Without debouncing, each triggers a separate Matter.js transaction.
    this.flushUpdate = debounce(this.flushPendingUpdate.bind(this), 50);
  }

  private clearTimers(): void {
    this.flushUpdate.clear();
  }

  // dispose calls close(), not delete(), so clean up in both
  override async delete() {
    this.clearTimers();
    await super.delete();
  }

  override async close() {
    this.clearTimers();
    await super.close();
  }

  async updateStates(states: HomeAssistantStates): Promise<void> {
    const state = states[this.entityId] ?? {};
    const mappedChanged = this.hasMappedEntityChanged(states);
    // Compare only meaningful fields, ignore volatile HA metadata
    // (last_changed, last_updated, context) that changes on every event
    // even when the actual device state/attributes are identical.
    // Skipping these prevents unnecessary Matter subscription reports
    // and reduces MRP traffic that can cause session loss.
    if (
      !mappedChanged &&
      state.state === this.lastState?.state &&
      JSON.stringify(state.attributes) ===
        JSON.stringify(this.lastState?.attributes)
    ) {
      return;
    }

    if (mappedChanged) {
      this.pendingMappedChange = true;
      logger.debug(
        `Mapped entity change detected for ${this.entityId}, forcing update`,
      );
    }
    logger.debug(
      `State update received for ${this.entityId}: state=${state.state}`,
    );
    this.lastState = state;
    this.flushUpdate(state);
  }

  private async flushPendingUpdate(state: HomeAssistantEntityState) {
    // When only a mapped entity changed (e.g. battery sensor), the primary
    // entity state is structurally identical. matter.js uses isDeepEqual on
    // setStateOf, so the entity$Changed event would never fire. Bump
    // last_updated to force a structural difference.
    let effectiveState = state;
    if (this.pendingMappedChange) {
      this.pendingMappedChange = false;
      effectiveState = { ...state, last_updated: new Date().toISOString() };
    }
    await updateEntityState(this, effectiveState);
  }
}
