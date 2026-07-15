import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import { Endpoint } from "@matter/main";
import type { EndpointType } from "@matter/main/node";
import type { HomeAssistantStates } from "../../services/home-assistant/home-assistant-registry.js";

export abstract class EntityEndpoint extends Endpoint {
  readonly mappedEntityIds: string[];
  private lastMappedStates: Record<string, string> = {};

  protected constructor(
    type: EndpointType,
    readonly entityId: string,
    customName?: string,
    mappedEntityIds?: string[],
  ) {
    super(type, { id: createEndpointId(entityId, customName) });
    this.mappedEntityIds = mappedEntityIds ?? [];
  }

  protected hasMappedEntityChanged(states: HomeAssistantStates): boolean {
    let changed = false;
    for (const mappedId of this.mappedEntityIds) {
      const mappedState = states[mappedId];
      if (!mappedState) continue;
      const fp = mappedState.state;
      if (fp !== this.lastMappedStates[mappedId]) {
        this.lastMappedStates[mappedId] = fp;
        changed = true;
      }
    }
    return changed;
  }

  abstract updateStates(states: HomeAssistantStates): Promise<void>;
}

export function createEndpointId(
  entityId: string,
  customName?: string,
): string {
  const baseName = customName || entityId;
  return baseName.replace(/\./g, "_").replace(/\s+/g, "_");
}

export function getMappedEntityIds(mapping?: EntityMappingConfig): string[] {
  if (!mapping) return [];
  const ids: string[] = [];
  if (mapping.batteryEntity) ids.push(mapping.batteryEntity);
  if (mapping.faultEntity) ids.push(mapping.faultEntity);
  if (mapping.chargingStateEntity) ids.push(mapping.chargingStateEntity);
  if (mapping.temperatureEntity) ids.push(mapping.temperatureEntity);
  if (mapping.humidityEntity) ids.push(mapping.humidityEntity);
  if (mapping.pressureEntity) ids.push(mapping.pressureEntity);
  if (mapping.cleaningModeEntity) ids.push(mapping.cleaningModeEntity);
  if (mapping.suctionLevelEntity) ids.push(mapping.suctionLevelEntity);
  if (mapping.mopIntensityEntity) ids.push(mapping.mopIntensityEntity);
  if (mapping.filterLifeEntity) ids.push(mapping.filterLifeEntity);
  if (mapping.powerEntity) ids.push(mapping.powerEntity);
  if (mapping.energyEntity) ids.push(mapping.energyEntity);
  if (mapping.currentRoomEntity) ids.push(mapping.currentRoomEntity);
  if (mapping.cleanedAreaEntity) ids.push(mapping.cleanedAreaEntity);
  if (mapping.composedEntities) {
    for (const sub of mapping.composedEntities) {
      if (sub.entityId) ids.push(sub.entityId);
    }
  }
  return ids;
}
