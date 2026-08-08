import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { createEndpointId, getMappedEntityIds } from "./entity-endpoint.js";

describe("getMappedEntityIds (#368)", () => {
  it("includes the cleaned-area sensor so its changes wake the endpoint", () => {
    // Without this, the m2 sensor is never subscribed and the cleaned-area
    // room tracking never re-runs as the sensor grows.
    const ids = getMappedEntityIds({
      cleanedAreaEntity: "sensor.vacuum_cleaned_area",
    } as EntityMappingConfig);
    expect(ids).toContain("sensor.vacuum_cleaned_area");
  });
});

describe("createEndpointId (#366)", () => {
  it("keeps distinct ids for two same-label switches without a custom name", () => {
    // The reporter had two switches sharing a friendly_name. With no custom
    // name the endpoint id falls back to the unique entity_id, so the ids stay
    // distinct and renaming the HA entity never collides them.
    expect(createEndpointId("switch.garage_left")).not.toBe(
      createEndpointId("switch.garage_right"),
    );
    expect(createEndpointId("switch.garage_left")).toBe("switch_garage_left");
  });

  it("replaces dots and spaces with underscores", () => {
    expect(createEndpointId("sensor.living_room", "Living Room Temp")).toBe(
      "Living_Room_Temp",
    );
  });

  it("collides when two entities share a custom name (current behaviour)", () => {
    // Documented footgun: a shared custom name collapses two distinct entities
    // onto one id, and matter.js then rejects the second add. Distinct
    // entity_ids never hit this; a future fix deriving the id from entity_id
    // would flip this assertion.
    expect(createEndpointId("switch.a", "Garage Switch")).toBe(
      createEndpointId("switch.b", "Garage Switch"),
    );
  });
});
