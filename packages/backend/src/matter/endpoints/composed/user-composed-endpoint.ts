import type {
  ComposedSubEntity,
  EntityMappingConfig,
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { Endpoint, type EndpointType } from "@matter/main";
import { FixedLabelServer } from "@matter/main/behaviors";
import { BridgedNodeEndpoint } from "@matter/main/endpoints";
import debounce from "debounce";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import type { HomeAssistantStates } from "../../../services/home-assistant/home-assistant-registry.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import { DefaultPowerSourceServer } from "../../behaviors/power-source-server.js";
import { createLegacyEndpointType } from "../legacy/create-legacy-endpoint-type.js";
import { updateEntityState } from "../update-entity-state.js";

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
  // Resolved stable endpoint id (keyed on the primary entity). Falls back to the
  // entity_id derivation when unset (#404).
  endpointId?: string;
  // Identity anchor (the primary's seed entity_id) so the parent freezes
  // uniqueId/serialNumber across a rename of the primary (#404).
  identityAnchor?: string;
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
  private lastMappedStates = new Map<string, string>();
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

    // Auto-mapped or explicit battery lives on the parent so controllers show
    // the device battery, not on a random sub-endpoint. Skipped when
    // disableBatteryMapping is set (#427), even if a batteryEntity is also
    // (contradictorily) configured.
    const hasParentBattery =
      !!config.mapping?.batteryEntity && !config.mapping?.disableBatteryMapping;
    if (hasParentBattery) {
      parentType = parentType.with(DefaultPowerSourceServer);
    }

    const endpointId =
      config.endpointId ?? createEndpointId(primaryEntityId, config.customName);
    const parts: Endpoint[] = [];
    const subEndpointMap = new Map<string, Endpoint>();
    const mappedIds: string[] = [];

    // Keep the battery entity subscribed even when it is out of the bridge filter.
    if (hasParentBattery && config.mapping?.batteryEntity) {
      mappedIds.push(config.mapping.batteryEntity);
    }

    // Primary entity sub-endpoint. The parent owns the device battery, so drop
    // batteryEntity from the mapping and the battery/battery_level attributes
    // from the payload. Domain factories pick a WithBattery variant from either
    // one, and a sub PowerSource would duplicate the parent. Shallow copies
    // only, the payload, state and attributes belong to the BridgeRegistry.
    let primaryMapping = config.mapping;
    let primarySubPayload = primaryPayload;
    if (config.mapping?.batteryEntity) {
      primaryMapping = { ...config.mapping, batteryEntity: undefined };
      const attributes = { ...primaryPayload.state.attributes };
      delete (attributes as Record<string, unknown>).battery;
      delete (attributes as Record<string, unknown>).battery_level;
      primarySubPayload = {
        ...primaryPayload,
        state: { ...primaryPayload.state, attributes },
      };
    }
    const primaryType = createLegacyEndpointType(
      primarySubPayload,
      primaryMapping,
      config.areaName,
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

      const subType = createLegacyEndpointType(
        subPayload,
        subMapping,
        config.areaName,
      );
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
        identityAnchor: config.identityAnchor,
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
    // A mapped entity with no sub-endpoint (the battery) never touches the
    // primary state, so the parent dedup would swallow it and the PowerSource
    // cluster would stay stale. Mirror the standalone path: force the parent
    // update so HomeAssistantEntityBehavior fires entity$Changed and PowerSource
    // re-reads the battery.
    const mappedChanged = this.hasMappedNonSubEntityChanged(states);

    // Update parent (BasicInformationServer reachable state)
    this.scheduleUpdate(this, this.entityId, states, mappedChanged);

    // Update sub-endpoints with their own entity states
    for (const [entityId, sub] of this.subEndpoints) {
      this.scheduleUpdate(sub, entityId, states);
    }
  }

  // A mapped entity without its own sub-endpoint (the battery) drives the parent
  // PowerSource, so track its state and report when it moves. Subs flush
  // themselves, so skip them here.
  private hasMappedNonSubEntityChanged(states: HomeAssistantStates): boolean {
    let changed = false;
    for (const mappedId of this.mappedEntityIds) {
      if (this.subEndpoints.has(mappedId)) continue;
      const mappedState = states[mappedId];
      if (!mappedState) continue;
      if (mappedState.state !== this.lastMappedStates.get(mappedId)) {
        this.lastMappedStates.set(mappedId, mappedState.state);
        changed = true;
      }
    }
    return changed;
  }

  private scheduleUpdate(
    endpoint: Endpoint,
    entityId: string,
    states: HomeAssistantStates,
    force = false,
  ) {
    const state = states[entityId];
    if (!state) return;

    const key = endpoint === this ? `_parent_:${entityId}` : entityId;

    const stateJson = JSON.stringify({
      s: state.state,
      a: state.attributes,
    });
    if (!force && this.lastStates.get(key) === stateJson) return;
    this.lastStates.set(key, stateJson);

    // When only a mapped entity (e.g. battery) changed the primary state is
    // structurally identical, so matter.js would skip the setStateOf. Bump
    // last_updated to force the entity$Changed the PowerSource reacts to.
    const effectiveState = force
      ? { ...state, last_updated: new Date().toISOString() }
      : state;

    let debouncedFn = this.debouncedUpdates.get(key);
    if (!debouncedFn) {
      debouncedFn = debounce(
        (ep: Endpoint, s: HomeAssistantEntityState) => this.flushUpdate(ep, s),
        50,
      );
      this.debouncedUpdates.set(key, debouncedFn);
    }
    debouncedFn(endpoint, effectiveState);
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
