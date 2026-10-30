import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import type { BridgeRegistry } from "../../../../../services/bridges/bridge-registry.js";

// Roborock's cleaning binary sensor describes the whole job, including recharges.
// Other integrations may stop their cleaning sensor during pauses; do not guess.
export function resolveVacuumJobMapping(
  registry: BridgeRegistry,
  entityId: string,
  mapping?: EntityMappingConfig,
): EntityMappingConfig | undefined {
  if (mapping?.cleaningJobEntity) return mapping;
  const vacuum = registry.entity(entityId);
  if (vacuum?.platform !== "roborock" || !vacuum.device_id) return mapping;
  const candidates = Object.values(registry.fullEntities).filter(
    (entity) =>
      entity.device_id === vacuum.device_id &&
      entity.platform === "roborock" &&
      entity.translation_key === "cleaning" &&
      entity.entity_id.startsWith("binary_sensor.") &&
      entity.disabled_by == null &&
      registry.initialStateIncludingUnfiltered(entity.entity_id),
  );
  if (candidates.length !== 1) return mapping;
  return { ...mapping, entityId, cleaningJobEntity: candidates[0].entity_id };
}
