import type {
  CleanAreaRoom,
  EntityMappingConfig,
  HomeAssistantDeviceRegistry,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
  HomeAssistantFilter,
  HomeAssistantMatcher,
  SensorDeviceAttributes,
  VacuumRoom,
} from "@home-assistant-matter-hub/common";
import {
  SensorDeviceClass,
  VacuumDeviceFeature,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { callService } from "home-assistant-js-websocket";
import { keys, pickBy, values } from "lodash-es";
import { sendHaMessage } from "../../utils/send-ha-message.js";
import type { HomeAssistantClient } from "../home-assistant/home-assistant-client.js";
import type {
  HomeAssistantDevices,
  HomeAssistantEntities,
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../home-assistant/home-assistant-registry.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import { resolveBatteryPercent } from "./entity-state-provider.js";
import { testMatchers } from "./matcher/matches-entity-filter.js";

// Battery marker inside a manager mapping fingerprint, a JSON tuple of
// [mapping, batteryEntityId] so mapping text can never collide with it (#450).
export function fingerprintBattery(fingerprint: string): string | null {
  try {
    const parsed = JSON.parse(fingerprint);
    return Array.isArray(parsed) && typeof parsed[1] === "string"
      ? parsed[1]
      : null;
  } catch {
    return null;
  }
}

export interface BridgeRegistryProps {
  readonly registry: HomeAssistantRegistry;
  readonly dataProvider: BridgeDataProvider;
}

export class BridgeRegistry {
  get entityIds() {
    return keys(this._entities);
  }

  private _devices: HomeAssistantDevices = {};
  private _entities: HomeAssistantEntities = {};
  private _states: HomeAssistantStates = {};

  // Track battery entities that have been auto-assigned to other devices
  private _usedBatteryEntities: Set<string> = new Set();
  // Cache for battery entity lookups (deviceId -> entityId or null)
  private _batteryEntityCache: Map<string, string | null> = new Map();
  // Cache for problem entity lookups (deviceId -> entityId or null) (#408)
  private _problemEntityCache: Map<string, string | null> = new Map();
  // Track humidity entities that have been auto-assigned to temperature sensors
  private _usedHumidityEntities: Set<string> = new Set();
  // Track pressure entities that have been auto-assigned to temperature sensors
  private _usedPressureEntities: Set<string> = new Set();
  // Track power entities that have been auto-assigned to switch/plug entities
  private _usedPowerEntities: Set<string> = new Set();
  // Track energy entities that have been auto-assigned to switch/plug entities
  private _usedEnergyEntities: Set<string> = new Set();
  // Track entities consumed by composed devices (e.g., sensors/climate grouped under air purifier)
  private _usedComposedSubEntities: Set<string> = new Set();

  deviceOf(entityId: string): HomeAssistantDeviceRegistry {
    const entity = this._entities[entityId];
    return this._devices[entity.device_id];
  }
  entity(entityId: string) {
    return this._entities[entityId];
  }
  initialState(entityId: string) {
    return this._states[entityId];
  }

  // The complete HA entity set (unfiltered). Used by orphan tombstone stamping
  // so a filter change or a scope narrowing never looks like a removal.
  get fullEntities() {
    return this.registry.entities;
  }

  // Successful-reload counter, see HomeAssistantRegistry (#438).
  get snapshotGeneration(): number {
    return this.registry.snapshotGeneration;
  }

  // composed sub-entities may sit outside the bridge filter (#408), so these
  // fall back to the full HA registry. keep them separate from the strict
  // accessors above, every other caller must stay filtered.
  initialStateIncludingUnfiltered(entityId: string) {
    return this._states[entityId] ?? this.registry.states[entityId];
  }
  entityIncludingUnfiltered(entityId: string) {
    return this._entities[entityId] ?? this.registry.entities[entityId];
  }
  deviceOfIncludingUnfiltered(
    entityId: string,
  ): HomeAssistantDeviceRegistry | undefined {
    const entity = this.entityIncludingUnfiltered(entityId);
    if (!entity) return undefined;
    return (
      this._devices[entity.device_id] ?? this.registry.devices[entity.device_id]
    );
  }

  /**
   * The battery sensor the auto-mapping would resolve for this entity right
   * now, or "" when auto-mapping does not apply. Part of the endpoint mapping
   * fingerprint: a sensor that was unavailable at endpoint creation used to be
   * negative-cached forever, the endpoint never rebuilt and the vacuum lost
   * its battery until a full restart (#450).
   */
  batteryFingerprintFor(
    entityId: string,
    mapping: EntityMappingConfig | undefined,
  ): string {
    if (mapping?.batteryEntity || mapping?.disableBatteryMapping) return "";
    // sensor endpoints never auto-map a battery, same gate as the managers
    if (
      entityId.startsWith("sensor.") ||
      entityId.startsWith("binary_sensor.")
    ) {
      return "";
    }
    if (
      !this.isAutoBatteryMappingEnabled() &&
      !entityId.startsWith("vacuum.")
    ) {
      return "";
    }
    const entity = this.entity(entityId);
    if (!entity?.device_id) return "";
    const resolved = this.findBatteryEntityForDevice(entity.device_id);
    return resolved && resolved !== entityId ? resolved : "";
  }

  /** Drop one cached battery answer so the next lookup resolves fresh (#450). */
  forgetBatteryCacheForDevice(deviceId: string): void {
    this._batteryEntityCache.delete(deviceId);
  }

  /**
   * Find a battery sensor entity that belongs to the same HA device.
   * Returns the entity_id of the battery sensor, or undefined if none found.
   */
  findBatteryEntityForDevice(deviceId: string): string | undefined {
    // Check cache first
    if (this._batteryEntityCache.has(deviceId)) {
      const cached = this._batteryEntityCache.get(deviceId);
      return cached === null ? undefined : cached;
    }

    // Search the FULL HA registry, not the filtered bridge entities.
    // The battery sensor might not match the bridge filter (e.g., vacuum
    // server bridges only include vacuum.* entities, not sensor.*).
    const entities = values(this.registry.entities);
    const sameDevice = entities.filter((e) => e.device_id === deviceId);

    // Prefer numeric sensor.* battery entities (percentage values).
    for (const entity of sameDevice) {
      if (!entity.entity_id.startsWith("sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) {
        continue;
      }

      const attrs = state.attributes as SensorDeviceAttributes;
      if (
        attrs.device_class === SensorDeviceClass.battery &&
        resolveBatteryPercent(state.state) != null
      ) {
        this._batteryEntityCache.set(deviceId, entity.entity_id);
        return entity.entity_id;
      }
    }

    // Fallback: binary_sensor.* with device_class=battery (on/off for LOW_BAT).
    // Old Homematic classic sensors only expose a binary LOW_BAT entity.
    for (const entity of sameDevice) {
      if (!entity.entity_id.startsWith("binary_sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as { device_class?: string };
      if (
        attrs.device_class === "battery" &&
        resolveBatteryPercent(state.state) != null
      ) {
        this._batteryEntityCache.set(deviceId, entity.entity_id);
        return entity.entity_id;
      }
    }

    // Fallback: enum-like HA battery sensors such as Overkiz full/normal/low.
    // A classless sensor needs "batt" in its id, otherwise any percentage on
    // the device gets mistaken for a battery: filter life, tank level,
    // last_clean_area (#461).
    for (const entity of sameDevice) {
      if (!entity.entity_id.startsWith("sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as {
        device_class?: string;
        unit_of_measurement?: string;
      };
      const looksLikeBattery = entity.entity_id.toLowerCase().includes("batt");
      if (
        (attrs.device_class === "enum" ||
          (attrs.device_class == null && looksLikeBattery)) &&
        resolveBatteryPercent(state.state) != null
      ) {
        this._batteryEntityCache.set(deviceId, entity.entity_id);
        return entity.entity_id;
      }
    }

    // Cache the negative result
    this._batteryEntityCache.set(deviceId, null);
    return undefined;
  }

  /**
   * Mark a battery entity as used (auto-assigned to another device).
   */
  markBatteryEntityUsed(entityId: string): void {
    this._usedBatteryEntities.add(entityId);
  }

  /**
   * Check if a battery entity has been auto-assigned to another device.
   */
  isBatteryEntityUsed(entityId: string): boolean {
    return this._usedBatteryEntities.has(entityId);
  }

  /**
   * Find a problem/safety binary sensor on the same HA device, so a smoke/CO
   * alarm can drive hardwareFaultAlert from it. Prefers device_class=problem
   * over safety. Returns the entity_id, or undefined if none found (#408).
   */
  findProblemEntityForDevice(deviceId: string): string | undefined {
    if (this._problemEntityCache.has(deviceId)) {
      const cached = this._problemEntityCache.get(deviceId);
      return cached === null ? undefined : cached;
    }

    // Search the FULL HA registry, not the filtered bridge entities, the
    // problem sensor may not match the bridge filter (same as battery).
    const entities = values(this.registry.entities);
    const sameDevice = entities.filter((e) => e.device_id === deviceId);

    let safety: string | undefined;
    for (const entity of sameDevice) {
      if (!entity.entity_id.startsWith("binary_sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as { device_class?: string };
      if (attrs.device_class === "problem") {
        this._problemEntityCache.set(deviceId, entity.entity_id);
        return entity.entity_id;
      }
      if (attrs.device_class === "safety" && !safety) {
        safety = entity.entity_id;
      }
    }

    this._problemEntityCache.set(deviceId, safety ?? null);
    return safety;
  }

  /**
   * Check if auto battery mapping is enabled for this bridge.
   */
  isAutoBatteryMappingEnabled(): boolean {
    return (
      this.dataProvider.featureFlags?.autoBatteryMapping === true ||
      this.dataProvider.featureFlags?.autoComposedDevices === true
    );
  }

  /**
   * Check if auto composed devices mode is enabled.
   * When enabled, temperature sensors with auto-mapped humidity/pressure/battery
   * build real Matter Composed Devices (BridgedNodeEndpoint with sub-endpoints)
   * rather than stacking extra clusters onto a flat TemperatureSensor.
   * Apple Home, Google Home, and Alexa render each sub-endpoint using its
   * own device type.
   */
  isAutoComposedDevicesEnabled(): boolean {
    return this.dataProvider.featureFlags?.autoComposedDevices === true;
  }

  /**
   * Check if the primary entity of a composed device lives on the parent
   * endpoint instead of on its own sub-endpoint (#469). Off by default: it
   * rewrites the endpoint tree of already commissioned composed devices.
   */
  isComposedPrimaryOnParentEnabled(): boolean {
    return this.dataProvider.featureFlags?.composedPrimaryOnParent === true;
  }

  /**
   * Check if auto humidity mapping is enabled for this bridge.
   * Default: true (enabled by default).
   * When enabled, humidity sensors on the same device as a temperature sensor
   * are combined into a single TemperatureHumiditySensor endpoint.
   * Note: Apple Home does not display humidity on TemperatureSensorDevice
   * endpoints, so users on Apple Home should explicitly disable this.
   * See: https://github.com/RiDDiX/home-assistant-matter-hub/issues/133
   */
  isAutoHumidityMappingEnabled(): boolean {
    return (
      this.dataProvider.featureFlags?.autoHumidityMapping !== false ||
      this.dataProvider.featureFlags?.autoComposedDevices === true
    );
  }

  /**
   * Find a humidity sensor entity that belongs to the same HA device.
   * Returns the entity_id of the humidity sensor, or undefined if none found.
   */
  findHumidityEntityForDevice(deviceId: string): string | undefined {
    // Search the FULL HA registry, not the filtered bridge entities.
    // Same reasoning as findBatteryEntityForDevice.
    const entities = values(this.registry.entities);
    for (const entity of entities) {
      if (entity.device_id !== deviceId) continue;
      if (!entity.entity_id.startsWith("sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as SensorDeviceAttributes;
      if (attrs.device_class === SensorDeviceClass.humidity) {
        return entity.entity_id;
      }
    }
    return undefined;
  }

  /**
   * Find a temperature sensor entity that belongs to the same HA device.
   * Returns the entity_id of the temperature sensor, or undefined if none found.
   */
  findTemperatureEntityForDevice(deviceId: string): string | undefined {
    const entities = values(this.registry.entities);
    for (const entity of entities) {
      if (entity.device_id !== deviceId) continue;
      if (!entity.entity_id.startsWith("sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as SensorDeviceAttributes;
      if (attrs.device_class === SensorDeviceClass.temperature) {
        return entity.entity_id;
      }
    }
    return undefined;
  }

  /**
   * Find a climate entity that belongs to the same HA device.
   * Returns the entity_id of the climate entity, or undefined if none found.
   */
  findClimateEntityForDevice(deviceId: string): string | undefined {
    const entities = values(this.registry.entities);
    for (const entity of entities) {
      if (entity.device_id !== deviceId) continue;
      if (!entity.entity_id.startsWith("climate.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (state) return entity.entity_id;
    }
    return undefined;
  }

  /**
   * Mark an entity as consumed by a composed device.
   */
  markComposedSubEntityUsed(entityId: string): void {
    this._usedComposedSubEntities.add(entityId);
  }

  /**
   * Check if an entity has been consumed by a composed device.
   */
  isComposedSubEntityUsed(entityId: string): boolean {
    return this._usedComposedSubEntities.has(entityId);
  }

  /**
   * Mark a humidity entity as used (auto-assigned to a temperature sensor).
   */
  markHumidityEntityUsed(entityId: string): void {
    this._usedHumidityEntities.add(entityId);
  }

  /**
   * Check if a humidity entity has been auto-assigned to a temperature sensor.
   */
  isHumidityEntityUsed(entityId: string): boolean {
    return this._usedHumidityEntities.has(entityId);
  }

  /**
   * Check if auto pressure mapping is enabled for this bridge.
   * Default: true (enabled by default).
   * When enabled, pressure sensors on the same device as a temperature sensor
   * are combined into a single endpoint with PressureMeasurement cluster.
   */
  isAutoPressureMappingEnabled(): boolean {
    return (
      this.dataProvider.featureFlags?.autoPressureMapping !== false ||
      this.dataProvider.featureFlags?.autoComposedDevices === true
    );
  }

  /**
   * Check if the vacuum OnOff cluster feature flag is enabled.
   * Defaults to OFF. OnOff is NOT part of the RoboticVacuumCleaner (0x74) device
   * type spec. Adding it makes the device non-conformant and causes Amazon Alexa
   * to reject it entirely (#185, #183). Only enable if a specific controller needs it.
   */
  isVacuumOnOffEnabled(): boolean {
    return this.dataProvider.featureFlags?.vacuumOnOff === true;
  }

  // Consume frozen device identities (#404). Seeding always runs; only
  // consumption of the stored endpoint id/anchor is gated on this flag.
  isStableIdentityEnabled(): boolean {
    return this.dataProvider.featureFlags?.stableIdentity === true;
  }

  /**
   * Check if the vacuum OnOff cluster should be included for server-mode vacuums.
   * Defaults to OFF. OnOff is NOT part of the RoboticVacuumCleaner (0x74) device
   * type spec. Adding it makes the device non-conformant and causes Amazon Alexa
   * to reject it entirely (#185, #183). Apple Home may also render the vacuum
   * incorrectly (shows "Updating" or switch UI). Only enable via feature flag
   * if a specific controller requires it.
   */
  isServerModeVacuumOnOffEnabled(): boolean {
    return this.dataProvider.featureFlags?.vacuumOnOff === true;
  }

  /**
   * Auto-detect vacuum-related select entities on the same HA device.
   * HA integrations (Dreame, Roborock, Ecovacs, Valetudo, etc.) expose vacuum
   * features as select entities with well-known suffixes. This finds them
   * automatically so users don't need to configure each entity manually.
   */
  findVacuumSelectEntities(deviceId: string): {
    cleaningModeEntity?: string;
    suctionLevelEntity?: string;
    mopIntensityEntity?: string;
    currentRoomEntity?: string;
  } {
    const entities = values(this.registry.entities);
    const sameDevice = entities.filter(
      (e) => e.device_id === deviceId && e.entity_id.startsWith("select."),
    );

    let cleaningModeEntity: string | undefined;
    let suctionLevelEntity: string | undefined;
    let mopIntensityEntity: string | undefined;

    for (const entity of sameDevice) {
      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const id = entity.entity_id.toLowerCase();

      // Cleaning mode: Dreame/Ecovacs use "cleaning_mode", Valetudo uses
      // plain "_mode" with vacuum-related options (vacuum, mop, etc.).
      if (!cleaningModeEntity) {
        if (id.includes("cleaning_mode")) {
          cleaningModeEntity = entity.entity_id;
        } else if (id.endsWith("_mode")) {
          const options = (state.attributes as { options?: string[] })?.options;
          if (
            options?.some((o) =>
              /^(vacuum|mop|sweep|sweep_mop|sweep_before_mopping|sweep_then_mop|vacuum_and_mop|vacuum_then_mop|mopping|sweeping|sweeping_and_mopping|mopping_after_sweeping)$/i.test(
                o.replace(/\s+/g, "_"),
              ),
            )
          ) {
            cleaningModeEntity = entity.entity_id;
          }
        }
      }

      // Suction level: Dreame/Ecovacs use "suction_level",
      // Valetudo uses "_fan" (e.g. select.valetudo_broesel_fan).
      if (
        !suctionLevelEntity &&
        (id.includes("suction_level") || id.endsWith("_fan"))
      ) {
        suctionLevelEntity = entity.entity_id;
      }

      // Mop intensity / water level: Dreame uses "mop_intensity" /
      // "mop_pad_humidity", others use "water_volume" / "water_amount",
      // Valetudo uses "_water" (e.g. select.valetudo_broesel_water).
      if (
        !mopIntensityEntity &&
        (id.includes("mop_intensity") ||
          id.includes("mop_pad_humidity") ||
          id.includes("water_volume") ||
          id.includes("water_amount") ||
          id.endsWith("_water"))
      ) {
        mopIntensityEntity = entity.entity_id;
      }
    }

    // Current room sensor: Dreame (Tasshack) exposes sensor.*_current_room
    // which reports the room name the vacuum is currently in.
    let currentRoomEntity: string | undefined;
    const sameDeviceSensors = entities.filter(
      (e) => e.device_id === deviceId && e.entity_id.startsWith("sensor."),
    );
    for (const entity of sameDeviceSensors) {
      if (entity.entity_id.toLowerCase().endsWith("_current_room")) {
        currentRoomEntity = entity.entity_id;
        break;
      }
    }

    return {
      cleaningModeEntity,
      suctionLevelEntity,
      mopIntensityEntity,
      currentRoomEntity,
    };
  }

  private static readonly valetudoLogger = Logger.get("ValetudoRooms");

  /**
   * Find Valetudo map segments from the sensor.*_map_segments entity on the
   * same HA device. Valetudo exposes room/segment data via MQTT as a sensor
   * with numeric segment IDs in its attributes.
   *
   * Attribute format:
   * - Unnamed segments: { "1": 1, "2": 2, "4": 4 }
   * - Named segments:   { "1": "Kitchen", "2": "Living Room" }
   */
  findValetudoMapSegments(deviceId: string): VacuumRoom[] {
    const entities = values(this.registry.entities);
    const mapSensor = entities.find(
      (e) =>
        e.device_id === deviceId &&
        e.entity_id.startsWith("sensor.") &&
        e.entity_id.endsWith("_map_segments"),
    );

    if (!mapSensor) return [];

    const state = this.registry.states[mapSensor.entity_id];
    if (!state) return [];

    const attrs = state.attributes as Record<string, unknown>;
    const rooms: VacuumRoom[] = [];

    for (const [key, value] of Object.entries(attrs)) {
      // Only process numeric keys (segment IDs); skip HA metadata
      // like icon, friendly_name, unit_of_measurement, etc.
      if (!/^\d+$/.test(key)) continue;

      const segmentId = Number.parseInt(key, 10);
      const name = typeof value === "string" ? value : `Segment ${key}`;
      rooms.push({ id: segmentId, name });
    }

    if (rooms.length > 0) {
      BridgeRegistry.valetudoLogger.info(
        `Found ${rooms.length} Valetudo segments via ${mapSensor.entity_id}`,
      );
    }
    return rooms;
  }

  private static readonly roborockLogger = Logger.get("RoborockRooms");

  /**
   * Resolve rooms for a Roborock vacuum by calling roborock.get_maps.
   * Returns parsed VacuumRoom[] with segment IDs, or empty array if
   * the service is unavailable or the vacuum is not Roborock.
   */
  async resolveRoborockRooms(entityId: string): Promise<VacuumRoom[]> {
    if (!this.client) return [];

    try {
      const raw = await callService(
        this.client.connection,
        "roborock",
        "get_maps",
        undefined,
        { entity_id: entityId },
        true,
      );

      // callService with returnResponse=true returns { context, response: { ... } }
      const wrapper = raw as Record<string, unknown> | undefined;
      const responseData =
        (wrapper?.response as Record<string, unknown>) ?? wrapper;

      const entityData = responseData?.[entityId] as
        | { maps?: Array<{ rooms?: Record<string, string>; name?: string }> }
        | undefined;

      if (!entityData?.maps) {
        BridgeRegistry.roborockLogger.debug(
          `${entityId}: roborock.get_maps returned no maps (keys: ${Object.keys(responseData ?? {}).join(", ")})`,
        );
        return [];
      }

      const rooms: VacuumRoom[] = [];
      for (const map of entityData.maps) {
        if (!map.rooms) continue;
        for (const [segmentId, roomName] of Object.entries(map.rooms)) {
          const id = /^\d+$/.test(segmentId)
            ? Number.parseInt(segmentId, 10)
            : segmentId;
          rooms.push({ id, name: roomName });
        }
      }

      if (rooms.length > 0) {
        BridgeRegistry.roborockLogger.info(
          `${entityId}: Resolved ${rooms.length} rooms via roborock.get_maps`,
        );
      }
      return rooms;
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null
            ? JSON.stringify(error)
            : String(error);
      BridgeRegistry.roborockLogger.warn(
        `${entityId}: roborock.get_maps failed: ${msg}`,
      );
      return [];
    }
  }

  private static readonly cleanAreaLogger = Logger.get("CleanAreaRooms");

  /**
   * Resolve HA areas mapped to vacuum segments via HA 2026.3 CLEAN_AREA.
   * Fetches the full entity registry entry (including options.vacuum.area_mapping)
   * and resolves HA area names from the area registry.
   * Returns CleanAreaRoom[] sorted alphabetically, or empty array if
   * CLEAN_AREA is not supported or no area_mapping is configured.
   */
  async resolveCleanAreaRooms(
    entityId: string,
    supportedFeatures: number,
  ): Promise<CleanAreaRoom[]> {
    if (!this.client) return [];
    if (!(supportedFeatures & VacuumDeviceFeature.CLEAN_AREA)) return [];

    try {
      const entry = await sendHaMessage<{
        options?: Record<string, Record<string, unknown>>;
      }>(this.client.connection, {
        type: "config/entity_registry/get",
        entity_id: entityId,
      });

      const vacuumOptions = entry?.options?.vacuum as
        | { area_mapping?: Record<string, string[]> }
        | undefined;
      const areaMapping = vacuumOptions?.area_mapping;
      if (!areaMapping || Object.keys(areaMapping).length === 0) {
        BridgeRegistry.cleanAreaLogger.debug(
          `${entityId}: CLEAN_AREA supported but no area_mapping configured`,
        );
        return [];
      }

      // Fetch the vacuum's current segments to detect stale area_mapping
      // entries whose segment IDs no longer exist on the device.
      let validSegmentIds: Set<string> | undefined;
      try {
        const segmentsResponse = await sendHaMessage<
          { id: string; name: string; group?: string | null }[]
        >(this.client.connection, {
          type: "vacuum/get_segments",
          entity_id: entityId,
        });
        if (Array.isArray(segmentsResponse)) {
          validSegmentIds = new Set(segmentsResponse.map((s) => s.id));
          BridgeRegistry.cleanAreaLogger.debug(
            `${entityId}: Current vacuum segments: ${[...validSegmentIds].join(", ")}`,
          );
        }
      } catch {
        // Older HA versions may not have the vacuum/get_segments endpoint.
        BridgeRegistry.cleanAreaLogger.debug(
          `${entityId}: vacuum/get_segments not available, skipping stale entry detection`,
        );
      }

      const rooms: CleanAreaRoom[] = [];
      for (const haAreaId of Object.keys(areaMapping)) {
        const segments = areaMapping[haAreaId];
        if (!segments || segments.length === 0) {
          BridgeRegistry.cleanAreaLogger.debug(
            `${entityId}: Skipping HA area ${haAreaId}, no segments mapped`,
          );
          continue;
        }
        // Skip entries where none of the segment IDs exist on the vacuum.
        if (
          validSegmentIds &&
          !segments.some((sid) => validSegmentIds!.has(sid))
        ) {
          const areaName = this.registry.areas.get(haAreaId) ?? haAreaId;
          BridgeRegistry.cleanAreaLogger.info(
            `${entityId}: Skipping stale HA area "${areaName}" (${haAreaId}), segments [${segments.join(", ")}] no longer exist on vacuum`,
          );
          continue;
        }
        const areaName = this.registry.areas.get(haAreaId) ?? haAreaId;
        rooms.push({
          areaId: hashAreaId(haAreaId),
          haAreaId,
          name: areaName,
        });
      }

      rooms.sort((a, b) => a.name.localeCompare(b.name));

      if (rooms.length > 0) {
        BridgeRegistry.cleanAreaLogger.info(
          `${entityId}: Resolved ${rooms.length} HA areas via CLEAN_AREA mapping`,
        );
      }
      return rooms;
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null
            ? JSON.stringify(error)
            : String(error);
      BridgeRegistry.cleanAreaLogger.warn(
        `${entityId}: Failed to resolve CLEAN_AREA mapping: ${msg}`,
      );
      return [];
    }
  }

  /**
   * Find a pressure sensor entity that belongs to the same HA device.
   * Returns the entity_id of the pressure sensor, or undefined if none found.
   */
  findPressureEntityForDevice(deviceId: string): string | undefined {
    const entities = values(this.registry.entities);
    for (const entity of entities) {
      if (entity.device_id !== deviceId) continue;
      if (!entity.entity_id.startsWith("sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as SensorDeviceAttributes;
      if (
        attrs.device_class === SensorDeviceClass.pressure ||
        attrs.device_class === SensorDeviceClass.atmospheric_pressure
      ) {
        return entity.entity_id;
      }
    }
    return undefined;
  }

  /**
   * Mark a pressure entity as used (auto-assigned to a temperature sensor).
   */
  markPressureEntityUsed(entityId: string): void {
    this._usedPressureEntities.add(entityId);
  }

  /**
   * Check if a pressure entity has been auto-assigned to a temperature sensor.
   */
  isPressureEntityUsed(entityId: string): boolean {
    return this._usedPressureEntities.has(entityId);
  }

  /**
   * Find a power sensor entity (device_class: power) on the same HA device.
   */
  findPowerEntityForDevice(deviceId: string): string | undefined {
    const entities = values(this.registry.entities);
    for (const entity of entities) {
      if (entity.device_id !== deviceId) continue;
      if (!entity.entity_id.startsWith("sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as SensorDeviceAttributes;
      if (attrs.device_class === SensorDeviceClass.power) {
        return entity.entity_id;
      }
    }
    return undefined;
  }

  /**
   * Find an energy sensor entity (device_class: energy) on the same HA device.
   */
  findEnergyEntityForDevice(deviceId: string): string | undefined {
    const entities = values(this.registry.entities);
    for (const entity of entities) {
      if (entity.device_id !== deviceId) continue;
      if (!entity.entity_id.startsWith("sensor.")) continue;

      const state = this.registry.states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as SensorDeviceAttributes;
      if (attrs.device_class === SensorDeviceClass.energy) {
        return entity.entity_id;
      }
    }
    return undefined;
  }

  markPowerEntityUsed(entityId: string): void {
    this._usedPowerEntities.add(entityId);
  }

  isPowerEntityUsed(entityId: string): boolean {
    return this._usedPowerEntities.has(entityId);
  }

  markEnergyEntityUsed(entityId: string): void {
    this._usedEnergyEntities.add(entityId);
  }

  isEnergyEntityUsed(entityId: string): boolean {
    return this._usedEnergyEntities.has(entityId);
  }

  constructor(
    private readonly registry: HomeAssistantRegistry,
    private readonly dataProvider: BridgeDataProvider,
    private readonly client?: HomeAssistantClient,
  ) {
    this.refresh();
  }

  mergeExternalStates(states: HomeAssistantStates): void {
    const registryStates = this.registry.states;
    for (const entityId of Object.keys(states)) {
      registryStates[entityId] = states[entityId];
    }
  }

  /**
   * Get the area name for an entity, resolving from HA area registry.
   * Priority: entity area_id > device area_id > undefined
   */
  getAreaName(entityId: string): string | undefined {
    const entity = this._entities[entityId];
    if (!entity) return undefined;

    // Entity-level area takes priority
    const entityAreaId = entity.area_id;
    if (entityAreaId) {
      const name = this.registry.areas.get(entityAreaId);
      if (name) return name;
    }

    // Fallback to device-level area
    const device = this._devices[entity.device_id];
    const deviceAreaId = device?.area_id as string | undefined;
    if (deviceAreaId) {
      const name = this.registry.areas.get(deviceAreaId);
      if (name) return name;
    }

    return undefined;
  }

  refresh() {
    // Clear used entities on refresh to allow re-assignment
    this._usedBatteryEntities.clear();
    this._usedHumidityEntities.clear();
    this._usedPressureEntities.clear();
    this._usedPowerEntities.clear();
    this._usedEnergyEntities.clear();
    this._usedComposedSubEntities.clear();
    // Clear lookup caches
    this._batteryEntityCache.clear();
    this._problemEntityCache.clear();

    this._entities = pickBy(this.registry.entities, (entity) => {
      const device = this.registry.devices[entity.device_id];
      const filter = this.dataProvider.filter;
      const featureFlags = this.dataProvider.featureFlags ?? {};

      // Always exclude disabled entities
      if (entity.disabled_by != null) {
        return false;
      }

      // Hidden entities are only included if includeHiddenEntities feature flag is enabled
      const isHidden = entity.hidden_by != null;
      if (isHidden && !featureFlags.includeHiddenEntities) {
        return false;
      }

      // Check filter matching
      const state = this.registry.states[entity.entity_id];
      return this.matchesFilter(filter, entity, device, state);
    });
    this._states = pickBy(
      this.registry.states,
      (e) => !!this._entities[e.entity_id],
    );
    this._devices = pickBy(this.registry.devices, (d) =>
      values(this._entities)
        .map((e) => e.device_id)
        .some((id) => d.id === id),
    );

    // Pre-calculate auto-assignments before endpoint creation so entities
    // are marked "used" regardless of the order they're processed later.
    this.preCalculateAutoAssignments();
  }

  /**
   * Pre-calculate which entities will be auto-assigned to other devices.
   * This must run BEFORE endpoint creation to ensure correct "used" marking
   * regardless of the order entities are processed.
   */
  private preCalculateAutoAssignments(): void {
    const entities = values(this._entities);

    // First pass: Find all temperature sensors and mark their humidity + pressure entities
    for (const entity of entities) {
      if (!entity.device_id) continue;
      if (!entity.entity_id.startsWith("sensor.")) continue;

      const state = this._states[entity.entity_id];
      if (!state) continue;

      const attrs = state.attributes as SensorDeviceAttributes;
      if (attrs.device_class === SensorDeviceClass.temperature) {
        if (this.isAutoHumidityMappingEnabled()) {
          const humidityEntityId = this.findHumidityEntityForDevice(
            entity.device_id,
          );
          if (humidityEntityId && humidityEntityId !== entity.entity_id) {
            this._usedHumidityEntities.add(humidityEntityId);
          }
        }
        if (this.isAutoPressureMappingEnabled()) {
          const pressureEntityId = this.findPressureEntityForDevice(
            entity.device_id,
          );
          if (pressureEntityId && pressureEntityId !== entity.entity_id) {
            this._usedPressureEntities.add(pressureEntityId);
          }
        }
      }
    }

    // Second pass: Find power and energy entities for switch/light entities
    for (const entity of entities) {
      if (!entity.device_id) continue;
      const domain = entity.entity_id.split(".")[0];
      if (domain !== "switch" && domain !== "light") continue;

      const powerEntityId = this.findPowerEntityForDevice(entity.device_id);
      if (powerEntityId && powerEntityId !== entity.entity_id) {
        if (!this._usedPowerEntities.has(powerEntityId)) {
          this._usedPowerEntities.add(powerEntityId);
        }
      }

      const energyEntityId = this.findEnergyEntityForDevice(entity.device_id);
      if (energyEntityId && energyEntityId !== entity.entity_id) {
        if (!this._usedEnergyEntities.has(energyEntityId)) {
          this._usedEnergyEntities.add(energyEntityId);
        }
      }
    }

    // Third pass: Find all "main" entities and mark their battery entities
    // A "main" entity is any entity that is NOT already marked as used
    if (this.isAutoBatteryMappingEnabled()) {
      for (const entity of entities) {
        if (!entity.device_id) continue;

        // Skip entities that are already marked as used (e.g., humidity sensors)
        if (this._usedHumidityEntities.has(entity.entity_id)) continue;

        // Skip battery sensors themselves (numeric and binary)
        if (entity.entity_id.startsWith("sensor.")) {
          const state = this._states[entity.entity_id];
          if (state) {
            const attrs = state.attributes as SensorDeviceAttributes;
            if (attrs.device_class === SensorDeviceClass.battery) continue;
          }
        }
        if (entity.entity_id.startsWith("binary_sensor.")) {
          const state = this._states[entity.entity_id];
          if (state) {
            const attrs = state.attributes as { device_class?: string };
            if (attrs.device_class === "battery") continue;
          }
        }

        const batteryEntityId = this.findBatteryEntityForDevice(
          entity.device_id,
        );
        if (batteryEntityId && batteryEntityId !== entity.entity_id) {
          // Only mark if not already marked (first entity wins)
          if (!this._usedBatteryEntities.has(batteryEntityId)) {
            this._usedBatteryEntities.add(batteryEntityId);
          }
        }
      }
    }
  }

  /**
   * The first already-matched entity the given matcher tests true for.
   * Server mode pins the primary entity to the first include matcher with
   * this, independent of HA registry order (#301).
   */
  firstEntityMatching(matcher: HomeAssistantMatcher): string | undefined {
    const labels = this.registry.labels;
    for (const entity of values(this._entities)) {
      const device = this.registry.devices[entity.device_id];
      const state = this.registry.states[entity.entity_id];
      if (testMatchers([matcher], device, entity, "any", state, labels)) {
        return entity.entity_id;
      }
    }
    return undefined;
  }

  private matchesFilter(
    filter: HomeAssistantFilter,
    entity: HomeAssistantEntityRegistry,
    device: HomeAssistantDeviceRegistry,
    entityState?: HomeAssistantEntityState,
  ) {
    const labels = this.registry.labels;
    if (
      filter.include.length > 0 &&
      !testMatchers(
        filter.include,
        device,
        entity,
        filter.includeMode,
        entityState,
        labels,
      )
    ) {
      return false;
    }
    if (
      filter.exclude.length > 0 &&
      testMatchers(filter.exclude, device, entity, "any", entityState, labels)
    ) {
      return false;
    }
    return true;
  }
}

function hashAreaId(areaId: string): number {
  let hash = 0;
  for (let i = 0; i < areaId.length; i++) {
    const char = areaId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}
