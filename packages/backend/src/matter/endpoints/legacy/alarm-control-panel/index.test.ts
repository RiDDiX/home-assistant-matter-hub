import { describe, expect, it } from "vitest";
import { AlarmControlPanelDevice } from "./index.js";

function description(friendlyName: string | undefined): string {
  const entity = {
    entity_id: "alarm_control_panel.home",
    state: {
      entity_id: "alarm_control_panel.home",
      state: "disarmed",
      attributes: { friendly_name: friendlyName, supported_features: 3 },
    },
  };
  const endpointType = AlarmControlPanelDevice({ entity } as never);
  // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
  const behaviors = (endpointType as any).behaviors;
  return behaviors.modeSelect.defaults.description;
}

describe("AlarmControlPanelDevice ModeSelect description", () => {
  it("cuts a long name to the 64 byte limit", () => {
    const value = description("Alarm ".repeat(20));
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(value.endsWith("...")).toBe(true);
  });

  it("keeps a short name and falls back without one", () => {
    expect(description("House alarm")).toBe("House alarm");
    expect(description(undefined)).toBe("Alarm Panel");
  });
});
