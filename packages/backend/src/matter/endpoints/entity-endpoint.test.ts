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

describe("createEndpointId storage length", () => {
  // matter.js file storage escapes the id like this inside the file name
  const encoded = (id: string) =>
    encodeURIComponent(id).replace(/[!'()*]/g, "%XX").length;

  it("keeps a short id unchanged", () => {
    expect(createEndpointId("switch.cjk", "开关")).toBe("开关");
  });

  it("keeps a 160 byte id unchanged", () => {
    const name = "a".repeat(160);
    expect(createEndpointId("switch.a", name)).toBe(name);
  });

  it("keeps an id of exactly 212 encoded bytes unchanged", () => {
    const name = "a".repeat(212);
    expect(createEndpointId("switch.a", name)).toBe(name);
  });

  it("shortens a 213 byte id to at most 154", () => {
    const id = createEndpointId("switch.a", "a".repeat(213));
    expect(id).not.toBe("a".repeat(213));
    expect(encoded(id)).toBeLessThanOrEqual(154);
  });

  it("shortens 60 CJK characters to at most 154", () => {
    const id = createEndpointId("switch.cjk", "开".repeat(60));
    expect(id.startsWith("开")).toBe(true);
    expect(encoded(id)).toBeLessThanOrEqual(154);
  });

  it("keeps a short id with a lone surrogate unchanged", () => {
    expect(createEndpointId("switch.a", "lamp one \ud83d")).toBe(
      "lamp_one_\ud83d",
    );
  });

  it("keeps an 81 character id with a lone surrogate unchanged", () => {
    const name = `${"a".repeat(80)}\ud83d`;
    expect(createEndpointId("switch.a", name)).toBe(name);
  });

  it("shortens a long id with a lone surrogate to at most 154", () => {
    const id = createEndpointId(
      "switch.a",
      `${"a".repeat(100)}\ud83d${"a".repeat(150)}`,
    );
    expect(encoded(id)).toBeLessThanOrEqual(154);
  });

  it("keeps a prefix for a long id of lone surrogates", () => {
    const id = createEndpointId("switch.a", "\ud83d".repeat(80));
    expect(id.startsWith("_")).toBe(false);
    expect(encoded(id)).toBeLessThanOrEqual(154);
  });

  it("is deterministic and keeps two long names apart", () => {
    const a = "开".repeat(60);
    const b = `${"开".repeat(59)}关`;
    expect(createEndpointId("switch.a", a)).toBe(
      createEndpointId("switch.b", a),
    );
    expect(createEndpointId("switch.a", a)).not.toBe(
      createEndpointId("switch.a", b),
    );
  });
});
