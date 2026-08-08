import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { InputSelectDevice, SelectDevice } from "./index.js";

function createEntity(
  entityId: string,
  state: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const registry: HomeAssistantEntityRegistry = {
    device_id: `${entityId}_device`,
    categories: {},
    entity_id: entityId,
    has_entity_name: false,
    id: entityId,
    original_name: entityId,
    platform: "test",
    unique_id: entityId,
  };
  const entityState: HomeAssistantEntityState = {
    entity_id: entityId,
    state,
    context: { id: "context" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
    attributes,
  };
  return { entity_id: entityId, registry, state: entityState };
}

function readSupportedModes(endpointType: unknown): {
  description: string;
  currentMode: number;
  supportedModes: Array<{
    label: string;
    mode: number;
    semanticTags: unknown[];
  }>;
} {
  // The endpoint type stores initial state under behaviors.<id>.defaults.
  // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
  const behaviors = (endpointType as any).behaviors as Record<string, unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
  const modeSelect = behaviors.modeSelect as any;
  return {
    description: modeSelect.defaults.description as string,
    currentMode: modeSelect.defaults.currentMode as number,
    supportedModes: modeSelect.defaults.supportedModes,
  };
}

describe("SelectDevice / InputSelectDevice ModeSelect labels (#296)", () => {
  it("input_select: supportedModes carry the HA option names as labels", () => {
    const entity = createEntity("input_select.house_mode", "Night", {
      friendly_name: "House Mode",
      options: ["Home", "Night", "Away", "Vacation"],
    });

    const endpointType = InputSelectDevice({ entity } as never);
    expect(endpointType).toBeDefined();

    const { description, currentMode, supportedModes } = readSupportedModes(
      endpointType!,
    );
    expect(description).toBe("House Mode");
    expect(currentMode).toBe(1);
    expect(supportedModes).toEqual([
      { label: "Home", mode: 0, semanticTags: [] },
      { label: "Night", mode: 1, semanticTags: [] },
      { label: "Away", mode: 2, semanticTags: [] },
      { label: "Vacation", mode: 3, semanticTags: [] },
    ]);
  });

  it("select: supportedModes carry the HA option names as labels", () => {
    const entity = createEntity("select.thermostat_mode", "heat", {
      friendly_name: "Thermostat Mode",
      options: ["off", "heat", "cool", "auto"],
    });

    const endpointType = SelectDevice({ entity } as never);
    expect(endpointType).toBeDefined();

    const { description, currentMode, supportedModes } = readSupportedModes(
      endpointType!,
    );
    expect(description).toBe("Thermostat Mode");
    expect(currentMode).toBe(1);
    expect(supportedModes.map((m) => m.label)).toEqual([
      "off",
      "heat",
      "cool",
      "auto",
    ]);
  });

  it("long labels are truncated to 64 chars (TLV max length)", () => {
    const longLabel = "a".repeat(100);
    const entity = createEntity("input_select.long", "short", {
      friendly_name: "Long",
      options: ["short", longLabel],
    });

    const endpointType = InputSelectDevice({ entity } as never);
    const { supportedModes } = readSupportedModes(endpointType!);
    expect(supportedModes[0].label).toBe("short");
    expect(supportedModes[1].label).toHaveLength(64);
    expect(supportedModes[1].label).toBe("a".repeat(64));
  });

  it("returns undefined when options are missing", () => {
    const entity = createEntity("input_select.empty", "unknown", {});
    expect(InputSelectDevice({ entity } as never)).toBeUndefined();
    expect(SelectDevice({ entity } as never)).toBeUndefined();
  });

  it("input_select calls input_select.select_option, select calls select.select_option", () => {
    const inputEntity = createEntity("input_select.house_mode", "Home", {
      friendly_name: "House Mode",
      options: ["Home", "Away"],
    });
    const selectEntity = createEntity("select.thermostat_mode", "heat", {
      friendly_name: "Thermostat Mode",
      options: ["heat", "cool"],
    });

    const readAction = (endpointType: unknown): string => {
      // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
      const behaviors = (endpointType as any).behaviors as Record<
        string,
        unknown
      >;
      // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
      const modeSelect = behaviors.modeSelect as any;
      const config = modeSelect.defaults.config as {
        selectOption: (option: string) => { action: string };
      };
      return config.selectOption("whatever").action;
    };

    expect(
      readAction(InputSelectDevice({ entity: inputEntity } as never)),
    ).toBe("input_select.select_option");
    expect(readAction(SelectDevice({ entity: selectEntity } as never))).toBe(
      "select.select_option",
    );
  });
});
