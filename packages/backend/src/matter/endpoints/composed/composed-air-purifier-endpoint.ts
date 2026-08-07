import type {
  EntityMappingConfig,
  FanDeviceAttributes,
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
  SensorDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { FanDeviceFeature } from "@home-assistant-matter-hub/common";
import {
  DestroyedDependencyError,
  Logger,
  TransactionDestroyedError,
} from "@matter/general";
import { Endpoint, type EndpointType } from "@matter/main";
import { FixedLabelServer } from "@matter/main/behaviors";
import type { FanControl } from "@matter/main/clusters";
import {
  AirPurifierDevice,
  HumiditySensorDevice,
  TemperatureSensorDevice,
} from "@matter/main/devices";
import { BridgedNodeEndpoint } from "@matter/main/endpoints";
import debounce from "debounce";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../services/bridges/entity-state-provider.js";
import { HomeAssistantConfig } from "../../../services/home-assistant/home-assistant-config.js";
import type { HomeAssistantStates } from "../../../services/home-assistant/home-assistant-registry.js";
import { autoPresetName } from "../../../utils/converters/fan-mode.js";
import { Temperature } from "../../../utils/converters/temperature.js";
import type { FeatureSelection } from "../../../utils/feature-selection.js";
import { testBit } from "../../../utils/test-bit.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import { HaElectricalEnergyMeasurementServer } from "../../behaviors/electrical-energy-measurement-server.js";
import { HaElectricalPowerMeasurementServer } from "../../behaviors/electrical-power-measurement-server.js";
import { FanSpeedMemoryBehavior } from "../../behaviors/fan-speed-memory.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import {
  type HumidityMeasurementConfig,
  HumidityMeasurementServer,
} from "../../behaviors/humidity-measurement-server.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import { PowerSourceServer } from "../../behaviors/power-source-server.js";
import { HaPowerTopologyServer } from "../../behaviors/power-topology-server.js";
import {
  type TemperatureMeasurementConfig,
  TemperatureMeasurementServer,
} from "../../behaviors/temperature-measurement-server.js";
import { AirPurifierHepaFilterMonitoringServer } from "../legacy/air-purifier/behaviors/air-purifier-hepa-filter-monitoring-server.js";
import { FanFanControlServer } from "../legacy/fan/behaviors/fan-fan-control-server.js";
import { FanOnOffServer } from "../legacy/fan/behaviors/fan-on-off-server.js";

const logger = Logger.get("ComposedAirPurifierEndpoint");

// --- Direct configs for sensor sub-endpoints (read from own entity state) ---

const temperatureConfig: TemperatureMeasurementConfig = {
  getValue(entity, agent) {
    const fallbackUnit =
      agent.env.get(HomeAssistantConfig).unitSystem.temperature;
    const state = entity.state;
    const attributes = entity.attributes as SensorDeviceAttributes;
    const temperature = state == null || Number.isNaN(+state) ? null : +state;
    if (temperature == null) return undefined;
    return Temperature.withUnit(
      temperature,
      attributes.unit_of_measurement ?? fallbackUnit,
    );
  },
};

const humidityConfig: HumidityMeasurementConfig = {
  getValue({ state }: HomeAssistantEntityState) {
    if (state == null || Number.isNaN(+state)) return null;
    return +state;
  },
};

const batteryConfig = {
  getBatteryPercent: (
    _entity: HomeAssistantEntityState,
    agent: { get: Function; env: { get: Function } },
  ): number | null => {
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const batteryEntity = homeAssistant.state.mapping?.batteryEntity;
    if (batteryEntity) {
      const stateProvider = agent.env.get(EntityStateProvider);
      const battery = stateProvider.getBatteryPercent(batteryEntity);
      if (battery != null) return Math.max(0, Math.min(100, battery));
    }
    return null;
  },
};

// --- Sub-endpoint types (without BasicInformationServer) ---

const TemperatureSubType = TemperatureSensorDevice.with(
  IdentifyServer,
  HomeAssistantEntityBehavior,
  TemperatureMeasurementServer(temperatureConfig),
);

const HumiditySubType = HumiditySensorDevice.with(
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HumidityMeasurementServer(humidityConfig),
);

// --- Helper ---

function createEndpointId(entityId: string, customName?: string): string {
  const baseName = customName || entityId;
  return baseName.replace(/\./g, "_").replace(/\s+/g, "_");
}

function buildEntityPayload(
  registry: BridgeRegistry,
  entityId: string,
): HomeAssistantEntityInformation | undefined {
  const state = registry.initialState(entityId);
  if (!state) return undefined;
  const entity = registry.entity(entityId);
  const deviceRegistry = registry.deviceOf(entityId);
  return {
    entity_id: entityId,
    state,
    registry: entity,
    deviceRegistry,
  };
}

// --- Air Purifier attributes ---

interface AirPurifierAttributes extends FanDeviceAttributes {
  filter_life?: number;
  filter_life_remaining?: number;
  filter_life_level?: number;
}

// --- Config interface ---

export interface ComposedAirPurifierConfig {
  registry: BridgeRegistry;
  primaryEntityId: string;
  temperatureEntityId?: string;
  humidityEntityId?: string;
  batteryEntityId?: string;
  powerEntityId?: string;
  energyEntityId?: string;
  mapping?: EntityMappingConfig;
  customName?: string;
  areaName?: string;
  // Resolved stable endpoint id (keyed on the primary entity). Falls back to the
  // entity_id derivation when unset (#404).
  endpointId?: string;
  // Identity anchor (the primary's seed entity_id) so the parent freezes
  // uniqueId/serialNumber across a rename of the primary (#404).
  identityAnchor?: string;
}

// --- Main class ---

/**
 * Composed air purifier endpoint built on BridgedNodeEndpoint with one
 * sub-endpoint for the purifier and one per sensor type, so every device
 * type only carries its spec-defined clusters. Apple Home ignores or
 * breaks on non-standard clusters, attaching TemperatureMeasurement
 * directly to AirPurifierDevice breaks the FanControl UI.
 *
 * Structure (per Matter spec §9.4.4):
 *   BridgedNodeEndpoint (parent - basic info + optional battery)
 *     ├── AirPurifierDevice (sub-endpoint - fan control + hepa filter)
 *     ├── TemperatureSensorDevice (sub-endpoint, if mapped)
 *     └── HumiditySensorDevice (sub-endpoint, if mapped)
 */
export class ComposedAirPurifierEndpoint extends Endpoint {
  readonly entityId: string;
  readonly mappedEntityIds: string[];
  private subEndpoints = new Map<string, Endpoint>();
  private lastStates = new Map<string, string>();
  private debouncedUpdates = new Map<
    string,
    ReturnType<
      typeof debounce<(ep: Endpoint, s: HomeAssistantEntityState) => void>
    >
  >();

  static async create(
    config: ComposedAirPurifierConfig,
  ): Promise<ComposedAirPurifierEndpoint | undefined> {
    const { registry, primaryEntityId } = config;

    const primaryPayload = buildEntityPayload(registry, primaryEntityId);
    if (!primaryPayload) return undefined;

    // Compute Air Purifier features from entity attributes
    const airPurifierAttributes = primaryPayload.state
      .attributes as AirPurifierAttributes;
    const supportedFeatures = airPurifierAttributes.supported_features ?? 0;
    const presetModes = airPurifierAttributes.preset_modes ?? [];
    const features: FeatureSelection<typeof FanControl.Cluster> = new Set();

    if (testBit(supportedFeatures, FanDeviceFeature.SET_SPEED)) {
      features.add("MultiSpeed");
      features.add("Step");
    }
    // Auto only if a preset really is "auto", else HA rejects the "auto" we send.
    if (
      testBit(supportedFeatures, FanDeviceFeature.PRESET_MODE) &&
      autoPresetName(presetModes) !== undefined
    ) {
      features.add("Auto");
    }
    if (testBit(supportedFeatures, FanDeviceFeature.DIRECTION)) {
      features.add("AirflowDirection");
    }
    if (testBit(supportedFeatures, FanDeviceFeature.OSCILLATE)) {
      features.add("Rocking");
    }
    const hasWindModes = presetModes.some(
      (m) =>
        m.toLowerCase() === "natural" ||
        m.toLowerCase() === "nature" ||
        m.toLowerCase() === "sleep",
    );
    if (hasWindModes) {
      features.add("Wind");
    }

    // Build AirPurifier sub-endpoint type (only spec-valid clusters)
    let airPurifierSubType = AirPurifierDevice.with(
      IdentifyServer,
      HomeAssistantEntityBehavior,
      FanOnOffServer,
      FanFanControlServer.with(...features),
      FanSpeedMemoryBehavior,
    );

    // Add HEPA filter monitoring if available
    const hasFilterLife =
      airPurifierAttributes.filter_life != null ||
      airPurifierAttributes.filter_life_remaining != null ||
      airPurifierAttributes.filter_life_level != null ||
      !!config.mapping?.filterLifeEntity;
    if (hasFilterLife) {
      airPurifierSubType = airPurifierSubType.with(
        AirPurifierHepaFilterMonitoringServer,
      );
    }

    // Mapping for the air purifier sub-endpoint (filter life sensor)
    const airPurifierMapping: EntityMappingConfig = {
      entityId: primaryEntityId,
      ...(config.mapping?.filterLifeEntity
        ? { filterLifeEntity: config.mapping.filterLifeEntity }
        : {}),
    };

    // Build parent type (BridgedNodeEndpoint with BasicInfo + optional battery)
    let parentType = BridgedNodeEndpoint.with(
      BasicInformationServer,
      IdentifyServer,
      HomeAssistantEntityBehavior,
    );

    const parentMapping: EntityMappingConfig = {
      entityId: primaryEntityId,
      ...(config.batteryEntityId
        ? { batteryEntity: config.batteryEntityId }
        : {}),
      ...(config.powerEntityId ? { powerEntity: config.powerEntityId } : {}),
      ...(config.energyEntityId ? { energyEntity: config.energyEntityId } : {}),
    };

    if (config.batteryEntityId) {
      parentType = parentType.with(PowerSourceServer(batteryConfig));
    }

    if (config.powerEntityId || config.energyEntityId) {
      parentType = parentType.with(HaPowerTopologyServer);
    }
    if (config.powerEntityId) {
      parentType = parentType.with(HaElectricalPowerMeasurementServer);
    }
    if (config.energyEntityId) {
      parentType = parentType.with(HaElectricalEnergyMeasurementServer);
    }

    if (config.areaName) {
      const truncatedName =
        config.areaName.length > 16
          ? config.areaName.substring(0, 16)
          : config.areaName;
      parentType = parentType.with(
        FixedLabelServer.set({
          labelList: [{ label: "room", value: truncatedName }],
        }),
      );
    }

    // Build sub-endpoints
    const endpointId =
      config.endpointId ?? createEndpointId(primaryEntityId, config.customName);
    const parts: Endpoint[] = [];

    // Air Purifier sub-endpoint (always present)
    const airPurifierSub = new Endpoint(
      airPurifierSubType.set({
        homeAssistantEntity: {
          entity: primaryPayload,
          mapping: airPurifierMapping,
        },
      }),
      { id: `${endpointId}_air_purifier` },
    );
    parts.push(airPurifierSub);

    // Temperature sub-endpoint (if mapped)
    let tempSub: Endpoint | undefined;
    if (config.temperatureEntityId) {
      const tempPayload = buildEntityPayload(
        registry,
        config.temperatureEntityId,
      );
      if (tempPayload) {
        tempSub = new Endpoint(
          TemperatureSubType.set({
            homeAssistantEntity: { entity: tempPayload },
          }),
          { id: `${endpointId}_temp` },
        );
        parts.push(tempSub);
      }
    }

    // Humidity sub-endpoint (if mapped)
    let humSub: Endpoint | undefined;
    if (config.humidityEntityId) {
      const humPayload = buildEntityPayload(registry, config.humidityEntityId);
      if (humPayload) {
        humSub = new Endpoint(
          HumiditySubType.set({
            homeAssistantEntity: { entity: humPayload },
          }),
          { id: `${endpointId}_humidity` },
        );
        parts.push(humSub);
      }
    }

    // Create parent endpoint with sub-endpoints as parts
    const parentTypeWithState = parentType.set({
      homeAssistantEntity: {
        entity: primaryPayload,
        customName: config.customName,
        mapping: parentMapping,
        identityAnchor: config.identityAnchor,
      },
    });

    // Expose non-primary entity IDs so bridge-endpoint-manager subscribes to
    // their state changes via WebSocket.
    const mappedIds: string[] = [];
    if (config.temperatureEntityId) mappedIds.push(config.temperatureEntityId);
    if (config.humidityEntityId) mappedIds.push(config.humidityEntityId);
    if (config.mapping?.filterLifeEntity)
      mappedIds.push(config.mapping.filterLifeEntity);
    if (config.powerEntityId) mappedIds.push(config.powerEntityId);
    if (config.energyEntityId) mappedIds.push(config.energyEntityId);

    const endpoint = new ComposedAirPurifierEndpoint(
      parentTypeWithState,
      primaryEntityId,
      endpointId,
      parts,
      mappedIds,
    );

    // Register sub-endpoints for state updates
    endpoint.subEndpoints.set(primaryEntityId, airPurifierSub);
    if (config.temperatureEntityId && tempSub) {
      endpoint.subEndpoints.set(config.temperatureEntityId, tempSub);
    }
    if (config.humidityEntityId && humSub) {
      endpoint.subEndpoints.set(config.humidityEntityId, humSub);
    }

    const clusterLabels = [
      "AirPurifier",
      config.temperatureEntityId ? "+Temp" : "",
      config.humidityEntityId ? "+Hum" : "",
      config.batteryEntityId ? "+Bat" : "",
      hasFilterLife ? "+HEPA" : "",
      config.powerEntityId ? "+Pwr" : "",
      config.energyEntityId ? "+Nrg" : "",
    ]
      .filter(Boolean)
      .join("");

    logger.info(
      `Created composed air purifier ${primaryEntityId}: ${clusterLabels}`,
    );

    return endpoint;
  }

  private constructor(
    type: EndpointType,
    entityId: string,
    id: string,
    parts: Endpoint[],
    mappedEntityIds: string[],
  ) {
    super(type, { id, parts });
    this.entityId = entityId;
    this.mappedEntityIds = mappedEntityIds;
  }

  async updateStates(states: HomeAssistantStates): Promise<void> {
    // Update parent (BasicInformationServer reachable state, battery, etc.)
    this.scheduleUpdate(this, this.entityId, states);

    // Update sub-endpoints with their own entity states
    for (const [entityId, sub] of this.subEndpoints) {
      this.scheduleUpdate(sub, entityId, states);
    }
  }

  private scheduleUpdate(
    endpoint: Endpoint,
    entityId: string,
    states: HomeAssistantStates,
  ) {
    const state = states[entityId];
    if (!state) return;

    // Use endpoint-specific key: the parent and air purifier sub-endpoint
    // share the same entityId, so a plain entityId key causes the
    // sub-endpoint update to be de-duped after the parent consumed the slot.
    const key = endpoint === this ? `_parent_:${entityId}` : entityId;

    const stateJson = JSON.stringify({
      s: state.state,
      a: state.attributes,
    });
    if (this.lastStates.get(key) === stateJson) return;
    this.lastStates.set(key, stateJson);

    let debouncedFn = this.debouncedUpdates.get(key);
    if (!debouncedFn) {
      debouncedFn = debounce(
        (ep: Endpoint, s: HomeAssistantEntityState) => this.flushUpdate(ep, s),
        50,
      );
      this.debouncedUpdates.set(key, debouncedFn);
    }
    debouncedFn(endpoint, state);
  }

  private async flushUpdate(
    endpoint: Endpoint,
    state: HomeAssistantEntityState,
  ) {
    try {
      await endpoint.construction.ready;
    } catch {
      return;
    }

    try {
      const current = endpoint.stateOf(HomeAssistantEntityBehavior).entity;
      await endpoint.setStateOf(HomeAssistantEntityBehavior, {
        entity: { ...current, state },
      });
    } catch (error) {
      if (
        error instanceof TransactionDestroyedError ||
        error instanceof DestroyedDependencyError
      ) {
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes(
          "Endpoint storage inaccessible because endpoint is not a node and is not owned by another endpoint",
        )
      ) {
        return;
      }
      throw error;
    }
  }

  override async delete() {
    for (const fn of this.debouncedUpdates.values()) {
      fn.clear();
    }
    await super.delete();
  }
}
