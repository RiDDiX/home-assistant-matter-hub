import { describe, expect, it } from "vitest";
import { ellipse, hash } from "./basic-information-server.js";

describe("basic information identifiers for same-label entities (#366)", () => {
  it("serialNumber hash stays distinct for two entity_ids sharing a long prefix", () => {
    // serialNumber falls back to hash(maxRawLen, entity_id). The 4-char md5
    // suffix is taken over the FULL id, so it survives the length cap (#330)
    // and two long ids sharing a 28-char prefix still differ.
    const a = `switch.${"x".repeat(28)}_left`;
    const b = `switch.${"x".repeat(28)}_right`;
    expect(hash(28, a)).not.toBe(hash(28, b));
    expect(hash(32, "switch.garage_left")).not.toBe(
      hash(32, "switch.garage_right"),
    );
  });

  it("nodeLabel from an identical friendly_name does collide (Alexa groups on the name)", () => {
    // nodeLabel uses ellipse (pure truncation, no hash), so two switches with
    // the same friendly_name get the same nodeLabel. That identical name is
    // what Alexa de-duplicates on for grouping, which is why renaming one
    // entity fixed #366. Documented, not an identifier bug.
    expect(ellipse(32, "Garage Switch")).toBe(ellipse(32, "Garage Switch"));
  });
});
