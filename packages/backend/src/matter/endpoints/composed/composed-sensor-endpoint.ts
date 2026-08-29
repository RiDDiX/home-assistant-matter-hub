import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
  SensorDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { Endpoint, type EndpointType } from "@matter/main";
import { FixedLabelServer } from "@matter/main/behaviors";
import {
  HumiditySensorDevice,
  PressureSensorDevice,
  TemperatureSensorDevice,
} from "@matter/main/devices";
import { BridgedNodeEndpoint } from "@matter/main/endpoints";
import debounce from "debounce";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../services/bridges/entity-state-provider.js";
import { HomeAssistantConfig } from "../../../services/home-assistant/home-assistant-config.js";
import type { HomeAssistantStates } from "../../../services/home-assistant/home-assistant-registry.js";
import { convertPressureToHpa } from "../../../utils/converters/pressure.js";
import { Temperature } from "../../../utils/converters/temperature.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import { HaElectricalEnergyMeasurementServer } from "../../behaviors/electrical-energy-measurement-server.js";
import { HaElectricalPowerMeasurementServer } from "../../behaviors/electrical-power-measurement-server.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import {
  type HumidityMeasurementConfig,
  HumidityMeasurementServer,
} from "../../behaviors/humidity-measurement-server.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import { PowerSourceServer } from "../../behaviors/power-source-server.js";
import { HaPowerTopologyServer } from "../../behaviors/power-topology-server.js";
import {
  type PressureMeasurementConfig,
  PressureMeasurementServer,
} from "../../behaviors/pressure-measurement-server.js";
import {
  type TemperatureMeasurementConfig,
  TemperatureMeasurementServer,
} from "../../behaviors/temperature-measurement-server.js";
import { updateEntityState } from "../update-entity-state.js";

const logger = Logger.get("ComposedSensorEndpoint");

// --- Direct configs for sub-endpoints (read from own entity state) ---

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

const pressureConfig: PressureMeasurementConfig = {
  getValue(entity) {
    const state = entity.state;
    const attributes = entity.attributes as SensorDeviceAttributes;
    const pressure = state == null || Number.isNaN(+state) ? null : +state;
    if (pressure == null) return undefined;
    return convertPressureToHpa(pressure, attributes.unit_of_measurement);
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

const PressureSubType = PressureSensorDevice.with(
  IdentifyServer,
  HomeAssistantEntityBehavior,
  PressureMeasurementServer(pressureConfig),
);

// --- Helper ---

function createEndpointId(entityId: string, customName?: string): string {
  const baseName = customName || entityId;
  return baseName.replace(/\./g, "_").replace(/\s+/g, "_");
}

// sub-entities may sit outside the bridge filter (#426, like #408); all three
// accessors must be unfiltered together, the strict deviceOf throws otherwise.
function buildEntityPayload(
  registry: BridgeRegistry,
  entityId: string,
): HomeAssistantEntityInformation | undefined {
  const state = registry.initialStateIncludingUnfiltered(entityId);
  if (!state) return undefined;
  const entity = registry.entityIncludingUnfiltered(entityId);
  const deviceRegistry = registry.deviceOfIncludingUnfiltered(entityId);
  return {
    entity_id: entityId,
    state,
    registry: entity,
    deviceRegistry,
  };
}

// --- Config interface ---

export interface ComposedSensorConfig {
  registry: BridgeRegistry;
  primaryEntityId: string;
  humidityEntityId?: string;
  pressureEntityId?: string;
  batteryEntityId?: string;
  powerEntityId?: string;
  energyEntityId?: string;
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
 * Composed sensor endpoint built on BridgedNodeEndpoint with one
 * sub-endpoint per sensor type. Each sub-endpoint carries its own Matter
 * device type, required for Apple Home, Google Home, and Alexa to
 * render humidity and pressure readings with the right icons and units.
 *
 * Structure:
 *   BridgedNodeEndpoint (parent - basic info + optional battery)
 *     ├── TemperatureSensorDevice (sub-endpoint)
 *     ├── HumiditySensorDevice (sub-endpoint, if mapped)
 *     └── PressureSensorDevice (sub-endpoint, if mapped)
 */
export class ComposedSensorEndpoint extends Endpoint {
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
    config: ComposedSensorConfig,
  ): Promise<ComposedSensorEndpoint | undefined> {
    const { registry, primaryEntityId } = config;

    const primaryPayload = buildEntityPayload(registry, primaryEntityId);
    if (!primaryPayload) return undefined;

    // Build parent type (BridgedNodeEndpoint with BasicInfo + optional battery)
    let parentType = BridgedNodeEndpoint.with(
      BasicInformationServer,
      IdentifyServer,
      HomeAssistantEntityBehavior,
    );

    const mapping: EntityMappingConfig = {
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

    // Temperature sub-endpoint (always present)
    const tempSub = new Endpoint(
      TemperatureSubType.set({
        homeAssistantEntity: { entity: primaryPayload },
      }),
      { id: `${endpointId}_temp` },
    );
    parts.push(tempSub);

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

    // Pressure sub-endpoint (if mapped)
    let pressSub: Endpoint | undefined;
    if (config.pressureEntityId) {
      const pressPayload = buildEntityPayload(
        registry,
        config.pressureEntityId,
      );
      if (pressPayload) {
        pressSub = new Endpoint(
          PressureSubType.set({
            homeAssistantEntity: { entity: pressPayload },
          }),
          { id: `${endpointId}_pressure` },
        );
        parts.push(pressSub);
      }
    }

    // Create parent endpoint with sub-endpoints as parts
    const parentTypeWithState = parentType.set({
      homeAssistantEntity: {
        entity: primaryPayload,
        customName: config.customName,
        mapping: mapping as EntityMappingConfig,
        identityAnchor: config.identityAnchor,
      },
    });

    // Expose non-primary sub-entity IDs so bridge-endpoint-manager subscribes
    // to their state changes via WebSocket.
    const mappedIds: string[] = [];
    if (config.batteryEntityId) mappedIds.push(config.batteryEntityId);
    if (config.humidityEntityId) mappedIds.push(config.humidityEntityId);
    if (config.pressureEntityId) mappedIds.push(config.pressureEntityId);
    if (config.powerEntityId) mappedIds.push(config.powerEntityId);
    if (config.energyEntityId) mappedIds.push(config.energyEntityId);

    const endpoint = new ComposedSensorEndpoint(
      parentTypeWithState,
      primaryEntityId,
      endpointId,
      parts,
      mappedIds,
    );

    // Register sub-endpoints for state updates
    endpoint.subEndpoints.set(primaryEntityId, tempSub);
    if (config.humidityEntityId && humSub) {
      endpoint.subEndpoints.set(config.humidityEntityId, humSub);
    }
    if (config.pressureEntityId && pressSub) {
      endpoint.subEndpoints.set(config.pressureEntityId, pressSub);
    }

    logger.info(
      `Created composed sensor ${primaryEntityId} with ${parts.length} sub-endpoint(s): ` +
        `T${humSub ? "+H" : ""}${pressSub ? "+P" : ""}${config.batteryEntityId ? "+Bat" : ""}${config.powerEntityId ? "+Pwr" : ""}${config.energyEntityId ? "+Nrg" : ""}`,
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

    // Use endpoint-specific key: the parent and temp sub-endpoint share the
    // same entityId, so a plain entityId key causes the sub-endpoint update
    // to be de-duped after the parent already consumed the slot.
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
    await updateEntityState(endpoint, state);
  }

  override async delete() {
    for (const fn of this.debouncedUpdates.values()) {
      fn.clear();
    }
    await super.delete();
  }
}
