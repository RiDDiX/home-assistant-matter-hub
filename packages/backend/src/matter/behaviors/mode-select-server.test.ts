import { describe, expect, it } from "vitest";
import { buildSupportedModes, findCurrentMode } from "./mode-select-server.js";

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

  it("cuts labels by UTF-8 bytes", () => {
    const label = buildSupportedModes(["\u5ba2".repeat(40)])[0].label;
    expect(label).toBe("\u5ba2".repeat(21));
  });

  it("caps the list at 255 modes and falls back for options beyond it", () => {
    const options = Array.from({ length: 300 }, (_, i) => `Option ${i}`);
    const modes = buildSupportedModes(options);
    expect(modes).toHaveLength(255);
    expect(modes[254]).toMatchObject({ label: "Option 254", mode: 254 });
    expect(findCurrentMode(options, "option 254")).toBe(254);
    expect(findCurrentMode(options, "Option 299")).toBe(0);
    expect(findCurrentMode(options, undefined)).toBe(0);
  });
});
