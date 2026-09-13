import type {
  EntityMappingConfig,
  HomeAssistantEntityState,
  SensorDeviceAttributes,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import {
  ClimateDeviceFeature,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import debounce from "debounce";
import { isEqual } from "lodash-es";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import type { HomeAssistantStates } from "../../../services/home-assistant/home-assistant-registry.js";
import { throttleLatest } from "../../../utils/throttle-latest.js";
import {
  EntityEndpoint,
  getMappedEntityIds,
} from "../../endpoints/entity-endpoint.js";
import { ComposedAirPurifierEndpoint } from "../composed/composed-air-purifier-endpoint.js";
import { ComposedClimateFanEndpoint } from "../composed/composed-climate-fan-endpoint.js";
import { ComposedSensorEndpoint } from "../composed/composed-sensor-endpoint.js";
import { UserComposedEndpoint } from "../composed/user-composed-endpoint.js";
import { asStandaloneEndpointType } from "../standalone-endpoint-type.js";
import { updateEntityState } from "../update-entity-state.js";
import { createLegacyEndpointType } from "./create-legacy-endpoint-type.js";
import { supportsCleaningModes } from "./vacuum/behaviors/vacuum-rvc-clean-mode-server.js";
import type { VacuumEffectiveConfig } from "./vacuum/behaviors/vacuum-service-area-server.js";

const logger = Logger.get("LegacyEndpoint");

/**
 * @deprecated
 */
export class LegacyEndpoint extends EntityEndpoint {
  public static async create(
    registry: BridgeRegistry,
    entityId: string,
    mapping?: EntityMappingConfig,
    pluginDomainMappings?: Map<string, string>,
    standalone = false,
    endpointId?: string,
    identityAnchor?: string,
  ): Promise<LegacyEndpoint | undefined> {
    const deviceRegistry = registry.deviceOf(entityId);
    let state = registry.initialState(entityId);
    const entity = registry.entity(entityId);
    // Skip entities without state (e.g., being enabled from disabled state)
    if (!state) {
      return;
    }

    // Auto-mapping: Skip entities that have been auto-assigned to another device
    if (
      registry.isAutoBatteryMappingEnabled() &&
      registry.isBatteryEntityUsed(entityId)
    ) {
      logger.debug(
        `Skipping ${entityId} - already auto-assigned as battery to another device`,
      );
      return;
    }
    if (
      registry.isAutoHumidityMappingEnabled() &&
      registry.isHumidityEntityUsed(entityId)
    ) {
      logger.debug(
        `Skipping ${entityId} - already auto-assigned as humidity to a temperature sensor`,
      );
      return;
    }
    if (
      registry.isAutoPressureMappingEnabled() &&
      registry.isPressureEntityUsed(entityId)
    ) {
      logger.debug(
        `Skipping ${entityId} - already auto-assigned as pressure to a temperature sensor`,
      );
      return;
    }
    if (
      registry.isAutoComposedDevicesEnabled() &&
      registry.isComposedSubEntityUsed(entityId)
    ) {
      logger.debug(
        `Skipping ${entityId} - already consumed by a composed device`,
      );
      return;
    }

    // Auto-assign related entities if not manually set and device has them
    // Order matters: Humidity first, then Pressure, then Battery - so battery only goes to the
    // combined sensor, not to both Temperature AND Humidity/Pressure separately
    let effectiveMapping = mapping;
    if (entity.device_id) {
      // 1. Auto-assign humidity entity to temperature sensors FIRST
      // Only applies when autoHumidityMapping feature flag is enabled (default: true)
      if (registry.isAutoHumidityMappingEnabled()) {
        const attrs = state.attributes as SensorDeviceAttributes;
        if (
          !mapping?.humidityEntity &&
          entityId.startsWith("sensor.") &&
          attrs.device_class === SensorDeviceClass.temperature
        ) {
          const humidityEntityId = registry.findHumidityEntityForDevice(
            entity.device_id,
          );
          if (humidityEntityId && humidityEntityId !== entityId) {
            effectiveMapping = {
              ...effectiveMapping,
              entityId: effectiveMapping?.entityId ?? entityId,
              humidityEntity: humidityEntityId,
            };
            registry.markHumidityEntityUsed(humidityEntityId);
            logger.debug(
              `Auto-assigned humidity ${humidityEntityId} to ${entityId}`,
            );
          }
        }
      }

      // 2. Auto-assign pressure entity to temperature sensors
      if (registry.isAutoPressureMappingEnabled()) {
        const attrs = state.attributes as SensorDeviceAttributes;
        if (
          !mapping?.pressureEntity &&
          entityId.startsWith("sensor.") &&
          attrs.device_class === SensorDeviceClass.temperature
        ) {
          const pressureEntityId = registry.findPressureEntityForDevice(
            entity.device_id,
          );
          if (pressureEntityId && pressureEntityId !== entityId) {
            effectiveMapping = {
              ...effectiveMapping,
              entityId: effectiveMapping?.entityId ?? entityId,
              pressureEntity: pressureEntityId,
            };
            registry.markPressureEntityUsed(pressureEntityId);
            logger.debug(
              `Auto-assigned pressure ${pressureEntityId} to ${entityId}`,
            );
          }
        }
      }

      // 3. Auto-assign battery entity AFTER humidity and pressure
      // For most entities: only when autoBatteryMapping feature flag is enabled
      // For vacuum entities: always auto-map because many HA integrations freeze
      // battery_level on the vacuum entity when docked, while the standalone
      // battery sensor keeps updating. Without mapping, the fallback reads the
      // stale attribute and the controller shows a stuck battery level.
      const isVacuum = entityId.startsWith("vacuum.");
      if (
        (registry.isAutoBatteryMappingEnabled() || isVacuum) &&
        !mapping?.batteryEntity &&
        !mapping?.disableBatteryMapping
      ) {
        const batteryEntityId = registry.findBatteryEntityForDevice(
          entity.device_id,
        );
        // Don't auto-assign battery to itself
        if (batteryEntityId && batteryEntityId !== entityId) {
          effectiveMapping = {
            ...effectiveMapping,
            entityId: effectiveMapping?.entityId ?? entityId,
            batteryEntity: batteryEntityId,
          };
          registry.markBatteryEntityUsed(batteryEntityId);
          logger.debug(
            `Auto-assigned battery ${batteryEntityId} to ${entityId}`,
          );
        }
      }

      // A docked vacuum otherwise reports charging whenever it is below full,
      // so take the device's own charging signal when it has one (#450).
      if (isVacuum && !mapping?.chargingStateEntity) {
        const chargingEntityId = registry.findChargingEntityForDevice(
          entity.device_id,
        );
        if (chargingEntityId && chargingEntityId !== entityId) {
          effectiveMapping = {
            ...effectiveMapping,
            entityId: effectiveMapping?.entityId ?? entityId,
            chargingStateEntity: chargingEntityId,
          };
          logger.debug(
            `Auto-assigned charging state ${chargingEntityId} to ${entityId}`,
          );
        }
      }

      // 3b. Auto-assign a problem/safety sensor to smoke/CO alarms so it drives
      // hardwareFaultAlert (#408). Gated exactly like battery mapping above.
      const alarmDeviceClass = (state.attributes as { device_class?: string })
        .device_class;
      const isSmokeCoAlarm =
        mapping?.matterDeviceType === "smoke_co_alarm" ||
        (entityId.startsWith("binary_sensor.") &&
          (alarmDeviceClass === "smoke" ||
            alarmDeviceClass === "carbon_monoxide" ||
            alarmDeviceClass === "gas"));
      if (
        registry.isAutoBatteryMappingEnabled() &&
        !mapping?.faultEntity &&
        isSmokeCoAlarm
      ) {
        const faultEntityId = registry.findProblemEntityForDevice(
          entity.device_id,
        );
        if (faultEntityId && faultEntityId !== entityId) {
          effectiveMapping = {
            ...effectiveMapping,
            entityId: effectiveMapping?.entityId ?? entityId,
            faultEntity: faultEntityId,
          };
          logger.debug(`Auto-assigned fault ${faultEntityId} to ${entityId}`);
        }
      }

      // 4. Auto-assign power entity to switch/plug entities.
      // Not lights: an outlet's indicator light would grab the outlet's power
      // sensor, and electrical clusters on a light endpoint break Aqara (#374).
      if (!mapping?.powerEntity) {
        const domain = entityId.split(".")[0];
        if (domain === "switch") {
          const powerEntityId = registry.findPowerEntityForDevice(
            entity.device_id,
          );
          if (powerEntityId && powerEntityId !== entityId) {
            effectiveMapping = {
              ...effectiveMapping,
              entityId: effectiveMapping?.entityId ?? entityId,
              powerEntity: powerEntityId,
            };
            registry.markPowerEntityUsed(powerEntityId);
            logger.debug(`Auto-assigned power ${powerEntityId} to ${entityId}`);
          }
        }
      }

      // 5. Auto-assign energy entity to switch/plug entities.
      // Lights excluded for the same reason as power above (#374).
      if (!mapping?.energyEntity) {
        const domain = entityId.split(".")[0];
        if (domain === "switch") {
          const energyEntityId = registry.findEnergyEntityForDevice(
            entity.device_id,
          );
          if (energyEntityId && energyEntityId !== entityId) {
            effectiveMapping = {
              ...effectiveMapping,
              entityId: effectiveMapping?.entityId ?? entityId,
              energyEntity: energyEntityId,
            };
            registry.markEnergyEntityUsed(energyEntityId);
            logger.debug(
              `Auto-assigned energy ${energyEntityId} to ${entityId}`,
            );
          }
        }
      }

      // 6. Auto-detect vacuum select entities (cleaning mode, suction, mop intensity)
      if (entityId.startsWith("vacuum.")) {
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
            `Auto-assigned cleaningMode ${vacuumEntities.cleaningModeEntity} to ${entityId}`,
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
            `Auto-assigned suctionLevel ${vacuumEntities.suctionLevelEntity} to ${entityId}`,
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
            `Auto-assigned mopIntensity ${vacuumEntities.mopIntensityEntity} to ${entityId}`,
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
            `Auto-assigned currentRoom ${vacuumEntities.currentRoomEntity} to ${entityId}`,
          );
        }

        // HA 2026.3 CLEAN_AREA: resolve HA area mapping before vendor-specific room detection
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
            `Using ${cleanAreaRooms.length} HA areas via CLEAN_AREA for ${entityId}`,
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
          // Try Valetudo map segments sensor first
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
            logger.debug(
              `Auto-detected ${valetudoRooms.length} Valetudo segments for ${entityId}`,
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
              logger.debug(
                `Auto-detected ${roborockRooms.length} Roborock rooms for ${entityId}`,
              );
            }
          }
        }
      }
    }

    // Composed shapes build a BridgedNodeEndpoint parent, which must not sit
    // directly under a server-mode root. In standalone mode they are skipped
    // and the entity falls through to a flat endpoint (#301).
    if (
      standalone &&
      ((effectiveMapping?.composedEntities?.length ?? 0) > 0 ||
        effectiveMapping?.climateExposeFan === true)
    ) {
      logger.warn(
        `Composed mappings are not supported in server mode, exposing ${entityId} as a flat standalone endpoint`,
      );
    }

    // User-defined composed device: when composedEntities is configured,
    // group the primary entity with additional entities into a single
    // Matter composed device under a BridgedNodeEndpoint parent.
    if (
      !standalone &&
      registry.isAutoComposedDevicesEnabled() &&
      effectiveMapping?.composedEntities &&
      effectiveMapping.composedEntities.length > 0
    ) {
      const composedAreaName = registry.getAreaName(entityId);
      const composed = await UserComposedEndpoint.create({
        registry,
        primaryEntityId: entityId,
        mapping: effectiveMapping,
        composedEntities: effectiveMapping.composedEntities,
        customName: effectiveMapping?.customName,
        areaName: composedAreaName,
        endpointId,
        identityAnchor,
      });
      if (composed) {
        return composed as unknown as LegacyEndpoint;
      }
      // Fallback to standalone if composed creation fails
      logger.warn(
        `User composed device creation failed for ${entityId}, falling back to standalone`,
      );
    }

    // When autoComposedDevices is enabled and this is a temperature sensor
    // with auto-mapped humidity/pressure, build a real Matter Composed Device
    // instead of a flat endpoint with extra clusters, Apple Home, Google
    // Home, and Alexa then render each sub-endpoint with its own device type.
    if (!standalone && registry.isAutoComposedDevicesEnabled()) {
      const attrs = state.attributes as SensorDeviceAttributes;
      if (
        entityId.startsWith("sensor.") &&
        attrs.device_class === SensorDeviceClass.temperature &&
        (effectiveMapping?.humidityEntity || effectiveMapping?.pressureEntity)
      ) {
        const composedAreaName = registry.getAreaName(entityId);
        const composed = await ComposedSensorEndpoint.create({
          registry,
          primaryEntityId: entityId,
          humidityEntityId: effectiveMapping?.humidityEntity,
          pressureEntityId: effectiveMapping?.pressureEntity,
          batteryEntityId: effectiveMapping?.disableBatteryMapping
            ? undefined
            : effectiveMapping?.batteryEntity,
          powerEntityId: effectiveMapping?.powerEntity,
          energyEntityId: effectiveMapping?.energyEntity,
          customName: effectiveMapping?.customName,
          areaName: composedAreaName,
          endpointId,
          identityAnchor,
        });
        // Return as LegacyEndpoint-compatible (duck typed: entityId + updateStates)
        return composed as unknown as LegacyEndpoint;
      }

      // When this is a fan entity mapped as air_purifier, create a composed
      // device with sensor clusters from related entities on the same HA
      // device or from manually mapped sensor entities (Matter spec 9.4.4).
      const resolvedMatterType =
        mapping?.matterDeviceType ??
        (entityId.startsWith("fan.") ? "fan" : undefined);
      if (resolvedMatterType === "air_purifier") {
        // Manual mapping takes priority over auto-discovery
        const temperatureEntityId =
          effectiveMapping?.temperatureEntity ||
          (entity.device_id
            ? registry.findTemperatureEntityForDevice(entity.device_id)
            : undefined);
        const humidityEntityId =
          effectiveMapping?.humidityEntity ||
          (entity.device_id
            ? registry.findHumidityEntityForDevice(entity.device_id)
            : undefined);
        // Only compose if at least one sensor sub-entity is available.
        // Climate entities stay standalone, ThermostatDevice competes with
        // the parent for Apple Home's primary tile selection.
        if (temperatureEntityId || humidityEntityId) {
          const composedAreaName = registry.getAreaName(entityId);
          const composed = await ComposedAirPurifierEndpoint.create({
            registry,
            primaryEntityId: entityId,
            temperatureEntityId,
            humidityEntityId,
            batteryEntityId: effectiveMapping?.disableBatteryMapping
              ? undefined
              : effectiveMapping?.batteryEntity,
            powerEntityId: effectiveMapping?.powerEntity,
            energyEntityId: effectiveMapping?.energyEntity,
            mapping: effectiveMapping,
            customName: effectiveMapping?.customName,
            areaName: composedAreaName,
            endpointId,
            identityAnchor,
          });
          if (composed) {
            return composed as unknown as LegacyEndpoint;
          }
        }
      }
    }

    // Companion Fan for climate ACs (#309): when opted in per-entity and the
    // climate entity supports fan modes, expose a second Matter Fan device
    // bound to the same entity so Apple Home gets a usable fan_only tile.
    if (
      !standalone &&
      entityId.startsWith("climate.") &&
      effectiveMapping?.climateExposeFan === true
    ) {
      const climateFeatures =
        (state.attributes as { supported_features?: number })
          .supported_features ?? 0;
      if ((climateFeatures & ClimateDeviceFeature.FAN_MODE) !== 0) {
        const composedAreaName = registry.getAreaName(entityId);
        const composed = await ComposedClimateFanEndpoint.create({
          registry,
          primaryEntityId: entityId,
          mapping: effectiveMapping,
          customName: effectiveMapping?.customName,
          areaName: composedAreaName,
          endpointId,
          identityAnchor,
        });
        if (composed) {
          return composed as unknown as LegacyEndpoint;
        }
        logger.warn(
          `Companion fan creation failed for ${entityId}, falling back to standalone`,
        );
      }
    }

    const payload = {
      entity_id: entityId,
      state,
      registry: entity,
      deviceRegistry,
    };

    // Resolve cleaning mode options for vacuum entities
    let cleaningModeOptions: string[] | undefined;
    if (entityId.startsWith("vacuum.")) {
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
          supportsCleaningModes(state.attributes as VacuumDeviceAttributes))
      ) {
        cleaningModeOptions = [
          "vacuum",
          "mop",
          "vacuum_and_mop",
          "vacuum_then_mop",
        ];
      }
    }

    const areaName = registry.getAreaName(entityId);
    let type = createLegacyEndpointType(
      payload,
      effectiveMapping,
      areaName,
      {
        vacuumOnOff: registry.isVacuumOnOffEnabled(),
        cleaningModeOptions,
        pluginDomainMappings,
      },
      identityAnchor,
    );
    if (!type) {
      return;
    }
    // server mode: present the device on its own node, not as a bridged child
    if (standalone) {
      type = asStandaloneEndpointType(type);
    }
    const customName = effectiveMapping?.customName;
    const mappedIds = getMappedEntityIds(effectiveMapping);
    // Snapshot what the vacuum clusters were built from, so the room switches
    // (#355) enumerate and dispatch against the same mapping/state. A fresh
    // object per create doubles as the recreation marker for the switches.
    const vacuumEffective = entityId.startsWith("vacuum.")
      ? { mapping: effectiveMapping, state }
      : undefined;
    return new LegacyEndpoint(
      type,
      entityId,
      customName,
      mappedIds,
      effectiveMapping?.updateThrottleMs,
      endpointId,
      vacuumEffective,
    );
  }

  private constructor(
    type: EndpointType,
    entityId: string,
    customName?: string,
    mappedEntityIds?: string[],
    throttleMs?: number,
    endpointId?: string,
    readonly vacuumEffective?: VacuumEffectiveConfig,
  ) {
    super(type, entityId, customName, mappedEntityIds, endpointId);
    // Batch rapid HA updates into a single Matter transaction. Home Assistant
    // often sends several attribute updates back to back (e.g. media player:
    // volume + source + play state); a 50ms debounce coalesces them and stays
    // imperceptible. When updateThrottleMs is set, a chatty sensor is throttled
    // to one report per that interval instead, keeping the latest value (#351).
    this.flushUpdate =
      throttleMs && throttleMs > 50
        ? throttleLatest(this.flushPendingUpdate.bind(this), throttleMs)
        : debounce(this.flushPendingUpdate.bind(this), 50);
  }

  private lastState?: HomeAssistantEntityState;
  private pendingMappedChange = false;
  private readonly flushUpdate: {
    (state: HomeAssistantEntityState): void;
    clear(): void;
  };

  override async delete() {
    // Clear any pending debounce timers to prevent callbacks firing after deletion
    this.flushUpdate.clear();
    await super.delete();
  }

  async updateStates(states: HomeAssistantStates) {
    const state = states[this.entityId] ?? {};
    const mappedChanged = this.hasMappedEntityChanged(states);
    // Compare only meaningful fields, ignore volatile HA metadata
    // (last_changed, last_updated, context) that changes on every event
    // even when the actual device state/attributes are identical.
    // Skipping these prevents unnecessary Matter subscription reports
    // and reduces MRP traffic that can cause session loss.
    if (!mappedChanged) {
      // Same state object ref: the HA diff never touched this entity.
      if (state === this.lastState) return;
      // Reused attributes ref skips the deep compare on the hot path.
      if (
        state.state === this.lastState?.state &&
        (state.attributes === this.lastState?.attributes ||
          isEqual(state.attributes, this.lastState?.attributes))
      ) {
        return;
      }
    }

    if (mappedChanged) {
      this.pendingMappedChange = true;
      logger.debug(
        `Mapped entity change detected for ${this.entityId} (${this.changedMappedIds.join(", ")}), forcing update`,
      );
    }
    logger.debug(
      `State update received for ${this.entityId}: state=${state.state}`,
    );
    this.lastState = state;

    // Event entities (buttons, doorbells) fire rapid sequential updates
    // (e.g. press_long then press_long_release 4ms later). The 50ms debounce
    // coalesces them, losing intermediate event_types. Process each update
    // immediately instead, updateEntityState keeps them in order.
    if (this.entityId.startsWith("event.")) {
      void this.flushPendingUpdate(state);
      return;
    }
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
