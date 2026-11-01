import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import type { BridgeRegistry } from "../../../../../services/bridges/bridge-registry.js";

/** Roborock enum sensors may be renamed and excluded from the export filter. */
export function resolveVacuumFaultMapping(
  registry: BridgeRegistry,
  entityId: string,
  mapping?: EntityMappingConfig,
): EntityMappingConfig | undefined {
  if (mapping?.faultEntity) return mapping;
  const vacuum = registry.entity(entityId);
  if (vacuum?.platform !== "roborock" || !vacuum.device_id) return mapping;
  const candidates = Object.values(registry.fullEntities).filter(
    (entity) =>
      entity.device_id === vacuum.device_id &&
      entity.platform === "roborock" &&
      entity.translation_key === "vacuum_error" &&
      entity.entity_id.startsWith("sensor.") &&
      entity.disabled_by == null &&
      registry.initialStateIncludingUnfiltered(entity.entity_id),
  );
  if (candidates.length !== 1) return mapping;
  return { ...mapping, entityId, faultEntity: candidates[0].entity_id };
}
