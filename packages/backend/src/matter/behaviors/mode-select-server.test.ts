import { describe, expect, it } from "vitest";
import { buildSupportedModes } from "./mode-select-server.js";

describe("buildSupportedModes", () => {
  it("keeps mode labels stable for runtime option updates", () => {
    expect(buildSupportedModes(["Home", "Night"])).toEqual([
      { label: "Home", mode: 0, semanticTags: [] },
      { label: "Night", mode: 1, semanticTags: [] },
    ]);
  });

  it("truncates labels to the Matter string limit", () => {
    expect(buildSupportedModes(["a".repeat(100)])[0].label).toBe(
      "a".repeat(64),
    );
  });
});
