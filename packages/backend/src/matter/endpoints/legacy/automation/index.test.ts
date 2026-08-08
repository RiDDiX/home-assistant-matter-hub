import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { AutomationDevice } from "./index.js";

function createEntity(
  entityId: string,
  state: string,
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
    attributes: {},
  };
  return { entity_id: entityId, registry, state: entityState };
}

describe("AutomationDevice OnOff mapping (#364)", () => {
  it("uses momentary trigger semantics instead of disabling the automation", () => {
    const endpointType = AutomationDevice({
      entity: createEntity("automation.fan_speed_1_matter", "off"),
    } as never);

    // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
    const behaviors = (endpointType as any).behaviors as Record<
      string,
      unknown
    >;
    // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
    const onOff = behaviors.onOff as any;
    const config = onOff.defaults.config as {
      isOn: () => boolean;
      turnOn: () => { action: string };
      turnOff: null | (() => { action: string });
    };

    expect(config.isOn()).toBe(false);
    expect(config.turnOn().action).toBe("automation.trigger");
    expect(config.turnOff).toBeNull();
  });

  it("does not advertise the OnOff Lighting feature (#182 Alexa conformance)", () => {
    const endpointType = AutomationDevice({
      entity: createEntity("automation.fan_speed_1_matter", "off"),
    } as never);

    // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
    const onOff = (endpointType as any).behaviors.onOff;
    expect(onOff.defaults.featureMap.lighting).toBe(false);
  });
});
