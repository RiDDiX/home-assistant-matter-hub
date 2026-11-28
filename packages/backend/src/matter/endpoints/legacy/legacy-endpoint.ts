import type {
  EntityMappingConfig,
  HomeAssistantEntityState,
  MatterDeviceType,
  SensorDeviceAttributes,
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
import {
  createLegacyEndpointType,
  resolveCleaningModeOptions,
} from "./create-legacy-endpoint-type.js";
import {
  type VacuumEffectiveConfig,
  withResolvedRooms,
} from "./vacuum/behaviors/vacuum-service-area-server.js";
import { resolveVacuumCompanionMapping } from "./vacuum/utils/resolve-vacuum-companion-mapping.js";
import { resolveVacuumFaultMapping } from "./vacuum/utils/resolve-vacuum-fault-mapping.js";

import { resolveVacuumJobMapping } from "./vacuum/utils/resolve-vacuum-job-mapping.js";

const logger = Logger.get("LegacyEndpoint");

const applianceTypes = new Set<MatterDeviceType>([
  "dishwasher",
  "laundry_washer",
  "laundry_dryer",
]);

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
      registry.isAutoComposedDevicesEnabled() &&
      registry.isComposedSubEntityUsed(entityId)
    ) {
      logger.debug(
        `Skipping ${entityId} - already consumed by a composed device`,
      );
      return;
    }

    const isTemperature =
      entityId.startsWith("sensor.") &&
      (state.attributes as SensorDeviceAttributes).device_class ===
        SensorDeviceClass.temperature;
    // The registry mounts humidity and pressure as separate endpoints.
    // Neither source is subscribed through a standalone temperature endpoint.
    let effectiveMapping = mapping;
    if (isTemperature && (mapping?.humidityEntity || mapping?.pressureEntity)) {
      effectiveMapping = {
        ...mapping,
        humidityEntity: undefined,
        pressureEntity: undefined,
      };
    }
    if (entity.device_id) {
      // Auto-assign battery when it was not mapped explicitly.
      // For most entities: only when autoBatteryMapping feature flag is enabled
      // For vacuum entities: always auto-map because many HA integrations freeze
      // battery_level on the vacuum entity when docked, while the standalone
      // battery sensor keeps updating. Without mapping, the fallback reads the
      // stale attribute and the controller shows a stuck battery level.
      const isVacuum = entityId.startsWith("vacuum.");
      if (
        (registry.isAutoBatteryMappingEnabled() || isVacuum) &&
        !registry.isTemperatureCompanionSharingBattery(entityId) &&
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

      // An appliance's power switch only reports on and off (#486).
      if (
        mapping?.matterDeviceType &&
        applianceTypes.has(mapping.matterDeviceType) &&
        !mapping.operationalStateEntity
      ) {
        const stateEntityId = registry.findOperationalStateEntityForDevice(
          entity.device_id,
        );
        if (stateEntityId && stateEntityId !== entityId) {
          effectiveMapping = {
            ...effectiveMapping,
            entityId: effectiveMapping?.entityId ?? entityId,
            operationalStateEntity: stateEntityId,
          };
          logger.debug(
            `Auto-assigned operational state ${stateEntityId} to ${entityId}`,
          );
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
            entityId,
          );
          if (powerEntityId && powerEntityId !== entityId) {
            effectiveMapping = {
              ...effectiveMapping,
              entityId: effectiveMapping?.entityId ?? entityId,
              powerEntity: powerEntityId,
            };
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
            entityId,
          );
          if (energyEntityId && energyEntityId !== entityId) {
            effectiveMapping = {
              ...effectiveMapping,
              entityId: effectiveMapping?.entityId ?? entityId,
              energyEntity: energyEntityId,
            };
            logger.debug(
              `Auto-assigned energy ${energyEntityId} to ${entityId}`,
            );
          }
        }
      }

      // 6. Auto-detect vacuum select entities (cleaning mode, suction, mop intensity)
      if (entityId.startsWith("vacuum.")) {
        ({ mapping: effectiveMapping, state } =
          await resolveVacuumCompanionMapping(
            registry,
            entityId,
            entity.device_id,
            state,
            effectiveMapping,
            logger,
            (message) => logger.debug(message),
          ));
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

    if (!standalone && registry.isAutoComposedDevicesEnabled()) {
      const temperatureCompanions = isTemperature
        ? registry.composedTemperatureCompanions(entityId)
        : undefined;
      if (temperatureCompanions) {
        const composedAreaName = registry.getAreaName(entityId);
        const composed = await ComposedSensorEndpoint.create({
          registry,
          primaryEntityId: entityId,
          ...temperatureCompanions,
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

    if (entityId.startsWith("vacuum.")) {
      effectiveMapping = resolveVacuumFaultMapping(
        registry,
        entityId,
        effectiveMapping,
      );
    }

    const payload = {
      entity_id: entityId,
      state,
      registry: entity,
      deviceRegistry,
    };

    if (entityId.startsWith("vacuum.")) {
      effectiveMapping = resolveVacuumJobMapping(
        registry,
        entityId,
        effectiveMapping,
      );
    }

    const cleaningModeOptions = resolveCleaningModeOptions(
      registry,
      payload,
      effectiveMapping,
    );

    const areaName = registry.getAreaName(entityId);
    let type = createLegacyEndpointType(
      payload,
      effectiveMapping,
      areaName,
      {
        vacuumOnOff: registry.isVacuumOnOffEnabled(),
        appleAdaptiveTemperature:
          standalone === true && registry.isAppleAdaptiveTemperatureEnabled(),
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
  private retriedState?: HomeAssistantEntityState;
  private pendingMappedChange = false;
  private readonly flushUpdate: {
    (state: HomeAssistantEntityState): void;
    clear(): void;
  };

  // delete() ends in close(), and a rebuild or bridge stop only closes, so
  // the queued flush must not outlive either (#461)
  override async close() {
    this.flushUpdate.clear();
    await super.close();
  }

  // delete() erases storage before it reaches close(), so clear first here too.
  override async delete() {
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
    let effectiveState = withResolvedRooms(state, this.vacuumEffective);
    const mappedChange = this.pendingMappedChange;
    if (mappedChange) {
      this.pendingMappedChange = false;
      effectiveState = {
        ...effectiveState,
        last_updated: new Date().toISOString(),
      };
    }
    // debounce and the event path drop this promise, a rejection would
    // otherwise surface as an unhandled rejection without the entity id
    try {
      await updateEntityState(this, effectiveState);
      this.retriedState = undefined;
    } catch (e) {
      logger.warn(`State update failed for ${this.entityId}:`, e);
      // the mapped value was not written either, keep its bump for the next flush
      if (mappedChange) this.pendingMappedChange = true;
      // let the next replay of this state write once more, events would fire twice
      if (
        this.entityId.startsWith("event.") ||
        this.retriedState === state ||
        this.lastState !== state
      ) {
        return;
      }
      this.retriedState = state;
      this.lastState = undefined;
    }
  }
}
