import { describe, expect, it } from "vitest";
import { RvcSupportedRunMode } from "../../../../behaviors/rvc-run-mode-server.js";
import { mapLawnMowerRunMode } from "./lawn-mower-rvc-run-mode-server.js";

describe("mapLawnMowerRunMode (#301 lawn mower)", () => {
  it("reports Cleaning while mowing or paused, Idle otherwise", () => {
    // paused stays Cleaning so the Matter rule (Cleaning when OpState=Paused) holds
    expect(mapLawnMowerRunMode({ state: "mowing" })).toBe(
      RvcSupportedRunMode.Cleaning,
    );
    expect(mapLawnMowerRunMode({ state: "paused" })).toBe(
      RvcSupportedRunMode.Cleaning,
    );
    expect(mapLawnMowerRunMode({ state: "docked" })).toBe(
      RvcSupportedRunMode.Idle,
    );
    expect(mapLawnMowerRunMode({ state: "returning" })).toBe(
      RvcSupportedRunMode.Idle,
    );
    expect(mapLawnMowerRunMode({ state: "error" })).toBe(
      RvcSupportedRunMode.Idle,
    );
  });
});
