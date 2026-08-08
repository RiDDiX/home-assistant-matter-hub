import type {
  ClimateDeviceAttributes,
  EntityMappingConfig,
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import {
  DestroyedDependencyError,
  Logger,
  TransactionDestroyedError,
} from "@matter/general";
import { Endpoint, type EndpointType } from "@matter/main";
import { FixedLabelServer } from "@matter/main/behaviors";
import { FanDevice } from "@matter/main/devices";
import { BridgedNodeEndpoint } from "@matter/main/endpoints";
import debounce from "debounce";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import type { HomeAssistantStates } from "../../../services/home-assistant/home-assistant-registry.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import {
  ClimateCompanionFanControlServer,
  ClimateCompanionFanOnOffServer,
} from "../legacy/climate/behaviors/climate-companion-fan-control-server.js";
import { climateSupportsAutoFanMode } from "../legacy/climate/behaviors/climate-fan-control-server.js";
import { ClimateDevice } from "../legacy/climate/index.js";

const logger = Logger.get("ComposedClimateFanEndpoint");

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
  return {
    entity_id: entityId,
    state,
    registry: registry.entity(entityId),
    deviceRegistry: registry.deviceOf(entityId),
  };
}

export interface ComposedClimateFanConfig {
  registry: BridgeRegistry;
  primaryEntityId: string;
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

/**
 * Composed climate + companion fan endpoint (#309). A BridgedNodeEndpoint
 * parent composes the existing climate device (RoomAirConditioner/Thermostat)
 * and a separate Fan device, BOTH bound to the same climate entity. Apple Home
 * does not surface a thermostat fan_only mode, so the Fan sub renders as its
 * own tile that drives the AC fan_only operation and its speed.
 *
 *   BridgedNodeEndpoint (parent, basic info)
 *     - ClimateDevice (sub, thermostat + AC clusters, no basic info)
 *     - FanDevice     (sub, companion fan_only on/off + speed)
 */
export class ComposedClimateFanEndpoint extends Endpoint {
  readonly entityId: string;
  readonly mappedEntityIds: string[] = [];
  private subEndpointList: Endpoint[] = [];
  private lastStates = new Map<string, string>();
  private debouncedUpdates = new Map<
    string,
    ReturnType<
      typeof debounce<(ep: Endpoint, s: HomeAssistantEntityState) => void>
    >
  >();

  static async create(
    config: ComposedClimateFanConfig,
  ): Promise<ComposedClimateFanEndpoint | undefined> {
    const { registry, primaryEntityId } = config;
    const payload = buildEntityPayload(registry, primaryEntityId);
    if (!payload) return undefined;

    const endpointId =
      config.endpointId ?? createEndpointId(primaryEntityId, config.customName);
    const mapping: EntityMappingConfig = config.mapping ?? {
      entityId: primaryEntityId,
    };

    let climateSub: Endpoint;
    try {
      // Reuse the existing climate device type WITHOUT BasicInformationServer
      // (the parent carries it). ClimateDevice already calls .set(...).
      const climateType = ClimateDevice(
        { entity: payload, customName: config.customName, mapping },
        false,
      );
      climateSub = new Endpoint(climateType, { id: `${endpointId}_climate` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Companion fan: climate sub build failed for ${primaryEntityId}: ${message}`,
      );
      return undefined;
    }

    const fanAttributes = payload.state.attributes as ClimateDeviceAttributes;
    const fanType = FanDevice.with(
      IdentifyServer,
      HomeAssistantEntityBehavior,
      ClimateCompanionFanOnOffServer,
      ClimateCompanionFanControlServer(
        climateSupportsAutoFanMode(fanAttributes.fan_modes),
      ),
    ).set({
      homeAssistantEntity: { entity: payload, mapping },
    });
    const fanSub = new Endpoint(fanType, { id: `${endpointId}_fan` });

    let parentType = BridgedNodeEndpoint.with(
      BasicInformationServer,
      IdentifyServer,
      HomeAssistantEntityBehavior,
    );
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
    const parentTypeWithState = parentType.set({
      homeAssistantEntity: {
        entity: payload,
        customName: config.customName,
        mapping,
        identityAnchor: config.identityAnchor,
      },
    });

    const endpoint = new ComposedClimateFanEndpoint(
      parentTypeWithState,
      primaryEntityId,
      endpointId,
      [climateSub, fanSub],
    );
    logger.info(`Created composed climate+fan endpoint ${primaryEntityId}`);
    return endpoint;
  }

  private constructor(
    type: EndpointType,
    entityId: string,
    id: string,
    parts: Endpoint[],
  ) {
    super(type, { id, parts });
    this.entityId = entityId;
    this.subEndpointList = parts;
  }

  async updateStates(states: HomeAssistantStates): Promise<void> {
    this.scheduleUpdate(this, states);
    for (const sub of this.subEndpointList) {
      this.scheduleUpdate(sub, states);
    }
  }

  private scheduleUpdate(endpoint: Endpoint, states: HomeAssistantStates) {
    const state = states[this.entityId];
    if (!state) return;

    // Parent and both subs share one entityId: key per endpoint id so the
    // updates are not de-duped against each other.
    const key = endpoint === this ? `_parent_:${this.entityId}` : endpoint.id;
    const stateJson = JSON.stringify({ s: state.state, a: state.attributes });
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
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes(
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
