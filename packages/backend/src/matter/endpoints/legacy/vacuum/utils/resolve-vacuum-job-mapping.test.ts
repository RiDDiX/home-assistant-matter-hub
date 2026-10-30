import type {
  EntityMappingConfig,
  HomeAssistantEntityRegistry,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { BridgeRegistry } from "../../../../../services/bridges/bridge-registry.js";
import { resolveVacuumJobMapping } from "./resolve-vacuum-job-mapping.js";

const robot = {
  entity_id: "vacuum.renamed",
  platform: "roborock",
  device_id: "robot",
};
const sensor = {
  entity_id: "binary_sensor.renamed",
  platform: "roborock",
  device_id: "robot",
  translation_key: "cleaning",
};

function registry(entries = [sensor], available = true, vacuum = robot) {
  return {
    entity: () => vacuum,
    fullEntities: Object.fromEntries(
      entries.map((entity) => [
        entity.entity_id,
        entity as HomeAssistantEntityRegistry,
      ]),
    ),
    initialStateIncludingUnfiltered: () =>
      available ? { state: "none" } : undefined,
  } as unknown as BridgeRegistry;
}

describe("vacuum job source discovery", () => {
  it("finds renamed same-device sensors independently of the export filter", () => {
    expect(resolveVacuumJobMapping(registry(), robot.entity_id)).toEqual({
      entityId: robot.entity_id,
      cleaningJobEntity: sensor.entity_id,
    });
  });
  it("keeps explicit mappings and unrelated properties", () => {
    const mapping: EntityMappingConfig = {
      entityId: robot.entity_id,
      cleaningJobEntity: "binary_sensor.custom",
      customName: "My robot",
    };
    expect(resolveVacuumJobMapping(registry(), robot.entity_id, mapping)).toBe(
      mapping,
    );
  });
  it("does not mutate the stored mapping", () => {
    const mapping = { entityId: robot.entity_id, customName: "Robot" };
    expect(
      resolveVacuumJobMapping(registry(), robot.entity_id, mapping)?.customName,
    ).toBe("Robot");
    expect(mapping).not.toHaveProperty("cleaningJobEntity");
  });
  it("rejects missing, disabled, ambiguous and unrelated sources", () => {
    const candidates = [
      registry([], true),
      registry([sensor], false),
      registry([{ ...sensor, device_id: "other" }]),
      registry([{ ...sensor, platform: "other" }]),
      registry([{ ...sensor, translation_key: "battery" }]),
      registry([{ ...sensor, disabled_by: "user" } as typeof sensor]),
      registry([sensor, { ...sensor, entity_id: "binary_sensor.second" }]),
      registry([sensor], true, { ...robot, platform: "other" }),
    ];
    for (const reg of candidates)
      expect(resolveVacuumJobMapping(reg, robot.entity_id)).toBeUndefined();
  });
});
