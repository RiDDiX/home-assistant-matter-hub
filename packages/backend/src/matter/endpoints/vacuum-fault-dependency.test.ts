import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../services/bridges/bridge-registry.js";
import type { HomeAssistantRegistry } from "../../services/home-assistant/home-assistant-registry.js";
import { LegacyEndpoint } from "./legacy/legacy-endpoint.js";
import { ServerModeVacuumEndpoint } from "./server-mode-vacuum-endpoint.js";

const vacuum = "vacuum.robot";
const select = "sensor.renamed_fault";

function registry(options?: string[]) {
  const entities = Object.fromEntries(
    [vacuum, select].map((id) => [
      id,
      {
        entity_id: id,
        device_id: "robot",
        platform: "roborock",
        translation_key: id === select ? "vacuum_error" : undefined,
        unique_id: id,
        categories: {},
        has_entity_name: false,
        id,
        original_name: id,
      } as HomeAssistantEntityRegistry,
    ]),
  );
  const states = Object.fromEntries(
    [vacuum, select].map((id) => [
      id,
      {
        entity_id: id,
        state: "docked",
        context: { id },
        last_changed: "2026-01-01T00:00:00Z",
        last_updated: "2026-01-01T00:00:00Z",
        attributes:
          id === select
            ? { options }
            : { supported_features: 15, rooms: { "1": "Room" } },
      } as unknown as HomeAssistantEntityState,
    ]),
  );
  return new BridgeRegistry(
    {
      entities,
      states,
      areas: new Map(),
      devices: { robot: { id: "robot", name: "Robot" } },
      labels: [],
    } as unknown as HomeAssistantRegistry,
    new BridgeDataProvider({
      id: "test",
      name: "test",
      port: 0,
      filter: {
        include: [{ type: "pattern", value: vacuum }],
        exclude: [],
        includeMode: "any",
      },
      featureFlags: {},
    } as unknown as ConstructorParameters<typeof BridgeDataProvider>[0]),
  );
}

describe.each([
  ["bridge", LegacyEndpoint],
  ["server", ServerModeVacuumEndpoint],
] as const)("%s mode Roborock fault dependency", (_name, Factory) => {
  it("auto-maps a renamed fault sensor without exporting it", async () => {
    const reg = registry(["vacuum", "mop"]);
    expect(reg.entityIds).toEqual([vacuum]);
    expect(reg.initialState(select)).toBeUndefined();
    const endpoint = await Factory.create(reg, vacuum);
    const mapping = endpoint?.vacuumEffective?.mapping;
    expect(mapping?.faultEntity).toBe(select);
    expect(endpoint?.mappedEntityIds).toContain(select);
    expect(reg.entityIds).toEqual([vacuum]);
  });
});
