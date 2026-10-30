import { RvcCleanMode } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import { buildSupportedModes } from "./vacuum-rvc-clean-mode-server.js";

const { Vacuum, Quiet, Max, Auto } = RvcCleanMode.ModeTag;
const profile = ["quiet", "balanced", "turbo", "max", "gentle"];

function tagged(
  tag: number,
  speeds = profile,
  overrides?: Record<string, number>,
) {
  return buildSupportedModes(speeds, undefined, undefined, overrides).filter(
    (mode) => mode.modeTags.some((entry) => entry.value === tag),
  );
}

describe("S5 Max intensity selection", () => {
  it("assigns Maximum to Max and Quiet to Quiet without moving mode IDs", () => {
    expect(tagged(Max).map((mode) => [mode.label, mode.mode])).toEqual([
      ["Max", 13],
    ]);
    expect(tagged(Quiet).map((mode) => [mode.label, mode.mode])).toEqual([
      ["Quiet", 10],
    ]);
    expect(tagged(Vacuum).map((mode) => mode.mode)).toEqual([
      0, 10, 11, 12, 13, 14,
    ]);
    expect(tagged(Auto).map((mode) => mode.label)).toEqual(["Balanced"]);
  });

  it("preserves explicit tag overrides", () => {
    expect(
      tagged(Max, profile, { turbo: Max }).map((mode) => mode.label),
    ).toEqual(["Turbo", "Max"]);
  });

  it("does not change other fan profiles", () => {
    expect(
      tagged(Max, ["quiet", "turbo", "max"]).map((mode) => mode.label),
    ).toEqual(["Turbo", "Max"]);
    expect(
      tagged(Quiet, ["gentle", "quiet", "high"]).map((mode) => mode.label),
    ).toEqual(["Gentle", "Quiet"]);
  });
});
