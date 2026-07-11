import type {
  ComposedSubEntity,
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
import { BridgedNodeEndpoint } from "@matter/main/endpoints";
import debounce from "debounce";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import type { HomeAssistantStates } from "../../../services/home-assistant/home-assistant-registry.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import { createLegacyEndpointType } from "../legacy/create-legacy-endpoint-type.js";

const logger = Logger.get("UserComposedEndpoint");

/**
 * Strip BridgedDeviceBasicInformation from an endpoint type.
 * Sub-endpoints in a composed device must not carry their own BasicInfo;
 * only the parent BridgedNodeEndpoint provides it.
 */
function stripBasicInformation(type: EndpointType): EndpointType {
  const behaviors = { ...type.behaviors };
  delete (behaviors as Record<string, unknown>).bridgedDeviceBasicInformation;
  return { ...type, behaviors };
}

function createEndpointId(entityId: string, customName?: string): string {
  const baseName = customName || entityId;
  return baseName.replace(/\./g, "_").replace(/\s+/g, "_");
}

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

export interface UserComposedConfig {
  registry: BridgeRegistry;
  primaryEntityId: string;
  mapping?: EntityMappingConfig;
  composedEntities: ComposedSubEntity[];
  customName?: string;
  areaName?: string;
}

/**
 * A user-defined composed endpoint that groups arbitrary HA entities
 * into a single Matter device using BridgedNodeEndpoint as the parent.
 *
 * Structure:
 *   BridgedNodeEndpoint (parent - basic info)
 *     ├── PrimaryDevice (sub-endpoint from primary entity)
 *     ├── SubDevice1 (sub-endpoint from composed entity 1)
 *     └── SubDevice2 (sub-endpoint from composed entity 2)
 */
export class UserComposedEndpoint extends Endpoint {
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
    config: UserComposedConfig,
  ): Promise<UserComposedEndpoint | undefined> {
    const { registry, primaryEntityId, composedEntities } = config;

    const primaryPayload = buildEntityPayload(registry, primaryEntityId);
    if (!primaryPayload) return undefined;

    // Build parent type (BridgedNodeEndpoint with BasicInfo)
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

    const endpointId = createEndpointId(primaryEntityId, config.customName);
    const parts: Endpoint[] = [];
    const subEndpointMap = new Map<string, Endpoint>();
    const mappedIds: string[] = [];

    // Primary entity sub-endpoint
    const primaryType = createLegacyEndpointType(
      primaryPayload,
      config.mapping,
      undefined,
      { vacuumOnOff: registry.isVacuumOnOffEnabled() },
    );
    if (!primaryType) {
      logger.warn(
        `Cannot create endpoint type for primary entity ${primaryEntityId}`,
      );
      return undefined;
    }

    const primarySub = new Endpoint(stripBasicInformation(primaryType), {
      id: `${endpointId}_primary`,
    });
    parts.push(primarySub);
    subEndpointMap.set(primaryEntityId, primarySub);

    // Composed sub-entity endpoints
    for (let i = 0; i < composedEntities.length; i++) {
      const sub = composedEntities[i];
      if (!sub.entityId) continue;

      const subPayload = buildEntityPayload(registry, sub.entityId);
      if (!subPayload) {
        logger.warn(
          `Cannot find state for composed sub-entity ${sub.entityId}, ` +
            `it does not exist in Home Assistant (removed or renamed?)`,
        );
        continue;
      }

      const subMapping: EntityMappingConfig = {
        entityId: sub.entityId,
        matterDeviceType: sub.matterDeviceType,
      };

      const subType = createLegacyEndpointType(subPayload, subMapping);
      if (!subType) {
        logger.warn(
          `Cannot create endpoint type for composed sub-entity ${sub.entityId}`,
        );
        continue;
      }

      const subEndpoint = new Endpoint(stripBasicInformation(subType), {
        id: `${endpointId}_sub_${i}`,
      });
      parts.push(subEndpoint);
      subEndpointMap.set(sub.entityId, subEndpoint);
      mappedIds.push(sub.entityId);
    }

    if (parts.length < 2) {
      logger.warn(
        `User composed device ${primaryEntityId}: only ${parts.length} sub-endpoint(s), ` +
          `need at least 2 (primary + one sub-entity). Falling back to standalone.`,
      );
      return undefined;
    }

    // Create parent endpoint with sub-endpoints as parts
    const parentTypeWithState = parentType.set({
      homeAssistantEntity: {
        entity: primaryPayload,
        customName: config.customName,
        mapping: config.mapping,
      },
    });

    const endpoint = new UserComposedEndpoint(
      parentTypeWithState,
      primaryEntityId,
      endpointId,
      parts,
      mappedIds,
    );

    endpoint.subEndpoints = subEndpointMap;

    const labels = parts
      .map((_, i) =>
        i === 0
          ? primaryEntityId.split(".")[0]
          : (composedEntities[i - 1]?.entityId?.split(".")[0] ?? "?"),
      )
      .join("+");

    logger.info(
      `Created user composed device ${primaryEntityId}: ${parts.length} sub-endpoint(s) [${labels}]`,
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
    // Update parent (BasicInformationServer reachable state)
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
