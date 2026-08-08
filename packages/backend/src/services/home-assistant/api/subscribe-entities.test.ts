import type { HassEntities, HassEntity } from "home-assistant-js-websocket";
import { describe, expect, it } from "vitest";
import { diffEntityRefs } from "./subscribe-entities.js";

function entity(state: string): HassEntity {
  return { entity_id: "x", state, attributes: {} } as HassEntity;
}

describe("diffEntityRefs", () => {
  it("returns null on the first emit so everything is processed", () => {
    const next: HassEntities = { "light.a": entity("on") };
    expect(diffEntityRefs(undefined, next)).toBeNull();
  });

  it("ignores entities whose object ref is unchanged", () => {
    const shared = entity("on");
    const prev: HassEntities = { "light.a": shared, "light.b": entity("off") };
    const next: HassEntities = { "light.a": shared, "light.b": entity("on") };
    const changed = diffEntityRefs(prev, next);
    expect(changed).not.toBeNull();
    expect(changed?.has("light.a")).toBe(false);
    expect(changed?.has("light.b")).toBe(true);
  });

  it("flags added and removed entities", () => {
    const keep = entity("on");
    const prev: HassEntities = { "light.a": keep, "light.gone": entity("on") };
    const next: HassEntities = { "light.a": keep, "light.new": entity("on") };
    const changed = diffEntityRefs(prev, next);
    expect(changed?.has("light.a")).toBe(false);
    expect(changed?.has("light.new")).toBe(true);
    expect(changed?.has("light.gone")).toBe(true);
  });
});
