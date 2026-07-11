import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { createLegacyEndpointType } from "./create-legacy-endpoint-type.js";

// #380: a switch defaults to OnOffPlugInUnit (0x010A, a plug). The "On/Off
// Switch" override used to map to the same plug factory, so it did nothing. It
// must now produce a different, switch-rendering device type.

function switchEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "switch.desk",
    state: "on",
    attributes: { friendly_name: "Desk" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "switch.desk", state: state as any };
}

describe("switch on_off_switch override (#380)", () => {
  it("override exposes On/Off Light, not the plug default", () => {
    const def = createLegacyEndpointType(switchEntity());
    const override = createLegacyEndpointType(switchEntity(), {
      matterDeviceType: "on_off_switch",
    } as EntityMappingConfig);
    expect(def?.deviceType).toBe(0x010a); // OnOffPlugInUnit (plug)
    expect(override?.deviceType).toBe(0x0100); // On/Off Light (switchable)
  });

  // #380 experiment: the mounted_on_off_control override must emit 0x010F.
  it("mounted_on_off_control override exposes 0x010F", () => {
    const mounted = createLegacyEndpointType(switchEntity(), {
      matterDeviceType: "mounted_on_off_control",
    } as EntityMappingConfig);
    expect(mounted?.deviceType).toBe(0x010f); // Mounted On/Off Control
  });
});
