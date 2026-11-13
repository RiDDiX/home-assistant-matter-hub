import crypto from "node:crypto";
import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import { Endpoint } from "@matter/main";
import type { EndpointType } from "@matter/main/node";
import type { HomeAssistantStates } from "../../services/home-assistant/home-assistant-registry.js";

export abstract class EntityEndpoint extends Endpoint {
  readonly mappedEntityIds: string[];
  private lastMappedStates: Record<string, string> = {};
  /** Mapped entities whose state changed in the last updateStates batch. */
  protected changedMappedIds: string[] = [];

  protected constructor(
    type: EndpointType,
    readonly entityId: string,
    customName?: string,
    mappedEntityIds?: string[],
    endpointId?: string,
  ) {
    super(type, { id: endpointId ?? createEndpointId(entityId, customName) });
    this.mappedEntityIds = mappedEntityIds ?? [];
  }

  protected hasMappedEntityChanged(states: HomeAssistantStates): boolean {
    this.changedMappedIds = [];
    for (const mappedId of this.mappedEntityIds) {
      const mappedState = states[mappedId];
      if (!mappedState) continue;
      const fp = mappedState.state;
      if (fp !== this.lastMappedStates[mappedId]) {
        this.lastMappedStates[mappedId] = fp;
        this.changedMappedIds.push(mappedId);
      }
    }
    return this.changedMappedIds.length > 0;
  }

  abstract updateStates(states: HomeAssistantStates): Promise<void>;
}

// root.parts.aggregator.parts.<id>.__number__.tmp fits 255 bytes: 255 - 28 - 15 = 212
const MAX_STORABLE_ID = 212;
// a shortened id fits every cluster key file plus a "_2" suffix
const SHORT_ID = 154;
// shortcut: 155 to 212 byte ids with long cluster keys and composed children fail, fix on report

// a lone surrogate cannot be URL encoded, so measure it as U+FFFD
function wellFormed(s: string): string {
  return s.replace(/[\u{D800}-\u{DFFF}]/gu, "\ufffd");
}

function encodedLength(id: string): number {
  return encodeURIComponent(wellFormed(id)).replace(/[!'()*]/g, "%XX").length;
}

export function createEndpointId(
  entityId: string,
  customName?: string,
): string {
  const baseName = customName || entityId;
  const id = baseName.replace(/\./g, "_").replace(/\s+/g, "_");
  if (encodedLength(id) <= MAX_STORABLE_ID) return id;
  const hash = crypto
    .createHash("sha256")
    .update(baseName)
    .digest("hex")
    .substring(0, 8);
  let prefix = "";
  for (const ch of wellFormed(id)) {
    if (encodedLength(prefix + ch) > SHORT_ID - hash.length - 1) break;
    prefix += ch;
  }
  return `${prefix}_${hash}`;
}

// A mapped entity without its own endpoint (battery, power, energy, filter
// life) is only re-read when the primary entity writes, so a composed endpoint
// has to force the primary through when one of them moved.
export function mappedNonSubStateChanged(
  mappedEntityIds: readonly string[],
  subEntityIds: ReadonlyMap<string, unknown>,
  states: HomeAssistantStates,
  lastMappedStates: Map<string, string>,
): boolean {
  let changed = false;
  for (const mappedId of mappedEntityIds) {
    if (subEntityIds.has(mappedId)) continue;
    const mappedState = states[mappedId];
    if (!mappedState) continue;
    if (mappedState.state !== lastMappedStates.get(mappedId)) {
      lastMappedStates.set(mappedId, mappedState.state);
      changed = true;
    }
  }
  return changed;
}

export function getMappedEntityIds(mapping?: EntityMappingConfig): string[] {
  if (!mapping) return [];
  const ids: string[] = [];
  if (mapping.batteryEntity && !mapping.disableBatteryMapping) {
    ids.push(mapping.batteryEntity);
  }
  if (mapping.faultEntity) ids.push(mapping.faultEntity);
  if (mapping.cleaningJobEntity) ids.push(mapping.cleaningJobEntity);
  if (mapping.chargingStateEntity) ids.push(mapping.chargingStateEntity);
  if (mapping.readinessEntity) ids.push(mapping.readinessEntity);
  if (mapping.temperatureEntity) ids.push(mapping.temperatureEntity);
  if (mapping.humidityEntity) ids.push(mapping.humidityEntity);
  if (mapping.pressureEntity) ids.push(mapping.pressureEntity);
  if (mapping.cleaningModeEntity) ids.push(mapping.cleaningModeEntity);
  if (mapping.suctionLevelEntity) ids.push(mapping.suctionLevelEntity);
  if (mapping.mopIntensityEntity) ids.push(mapping.mopIntensityEntity);
  if (mapping.filterLifeEntity) ids.push(mapping.filterLifeEntity);
  if (mapping.powerEntity) ids.push(mapping.powerEntity);
  if (mapping.energyEntity) ids.push(mapping.energyEntity);
  if (mapping.voltageEntity) ids.push(mapping.voltageEntity);
  if (mapping.currentEntity) ids.push(mapping.currentEntity);
  if (mapping.batteryPowerEntity) ids.push(mapping.batteryPowerEntity);
  if (mapping.batteryEnergyEntity) ids.push(mapping.batteryEnergyEntity);
  if (mapping.chargingSwitchEntity) ids.push(mapping.chargingSwitchEntity);
  if (mapping.currentLimitEntity) ids.push(mapping.currentLimitEntity);
  if (mapping.currentRoomEntity) ids.push(mapping.currentRoomEntity);
  if (mapping.cleanedAreaEntity) ids.push(mapping.cleanedAreaEntity);
  if (mapping.operationalStateEntity) ids.push(mapping.operationalStateEntity);
  if (mapping.composedEntities) {
    for (const sub of mapping.composedEntities) {
      if (sub.entityId) ids.push(sub.entityId);
    }
  }
  return ids;
}
