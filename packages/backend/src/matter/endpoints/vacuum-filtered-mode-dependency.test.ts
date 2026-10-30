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
const select = "select.robot_cleaning_mode";

function registry(options?: string[]) {
  const entities = Object.fromEntries(
    [vacuum, select].map((id) => [
      id,
      {
        entity_id: id,
        device_id: "robot",
        platform: "test",
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
        attributes: id === select ? { options } : { supported_features: 15 },
      } as HomeAssistantEntityState,
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
] as const)("%s mode cleaning-mode dependency", (_name, Factory) => {
  it("reads the real options without exporting the select", async () => {
    const reg = registry(["vacuum", "mop"]);
    expect(reg.entityIds).toEqual([vacuum]);
    expect(reg.initialState(select)).toBeUndefined();
    const endpoint = await Factory.create(reg, vacuum, {
      entityId: vacuum,
      cleaningModeEntity: select,
    });
    // biome-ignore lint/suspicious/noExplicitAny: inspect configured endpoint defaults without starting a node
    const modes = (endpoint as any).type.behaviors.rvcCleanMode.defaults
      .supportedModes;
    expect(modes.map((mode: { label: string }) => mode.label)).toEqual([
      "Vacuum",
      "Mop",
    ]);
    expect(endpoint?.mappedEntityIds).toContain(select);
    expect(reg.entityIds).toEqual([vacuum]);
  });
});
