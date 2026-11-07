import { updateBridgeRequestSchema } from "@home-assistant-matter-hub/common";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

const bridge = {
  id: "b1",
  name: "Bridge",
  port: 5540,
  filter: { include: [], exclude: [] },
};

describe("bridge request schema", () => {
  // A bridge saved by an older version can still carry a removed flag,
  // like omitEventsInPriming. Saving it again must not be rejected.
  it("accepts unknown feature flags", () => {
    const valid = new Ajv().validate(updateBridgeRequestSchema, {
      id: "b1",
      name: "Bridge",
      port: 5540,
      filter: { include: [], exclude: [] },
      featureFlags: { omitEventsInPriming: true },
    });
    expect(valid).toBe(true);
  });

  // The id becomes the matter.js storage directory name.
  it.each(["../escape", "/tmp/abs", "a.b", ""])("rejects id %j", (id) => {
    expect(
      new Ajv().validate(updateBridgeRequestSchema, { ...bridge, id }),
    ).toBe(false);
  });

  it("accepts generated and legacy uuid ids", () => {
    for (const id of [
      "0f3c2a1b4d5e6f708192a3b4c5d6e7f8",
      "0f3c2a1b-4d5e-6f70-8192-a3b4c5d6e7f8",
    ]) {
      expect(
        new Ajv().validate(updateBridgeRequestSchema, { ...bridge, id }),
      ).toBe(true);
    }
  });

  it.each([0, 65536, 5540.5])("rejects port %d", (port) => {
    expect(
      new Ajv().validate(updateBridgeRequestSchema, { ...bridge, port }),
    ).toBe(false);
  });
});
