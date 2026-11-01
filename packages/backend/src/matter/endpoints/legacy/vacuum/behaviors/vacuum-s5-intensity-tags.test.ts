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

describe("automatic intensity selection", () => {
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
    ).toEqual(["Turbo"]);
  });

  it.each([
    ["quiet", "turbo", "max"],
    ["gentle", "quiet", "balanced", "turbo", "max", "off", "custom"],
    ["max_plus", "gentle", "max", "turbo", "quiet", "off", "custom"],
  ])("deduplicates arbitrary profile %j", (...speeds) => {
    for (const tag of [Quiet, Max, Auto])
      expect(tagged(tag, speeds)).toHaveLength(
        tag === Auto && !speeds.includes("balanced") ? 0 : 1,
      );
    expect(tagged(Max, speeds)[0].label).toBe(
      speeds.includes("max_plus") ? "Max Plus" : "Max",
    );
    expect(tagged(Quiet, speeds)[0].label).toBe("Quiet");
  });
  it("keeps all mode IDs and lets explicit duplicate overrides remain explicit", () => {
    const speeds = [
      "off",
      "quiet",
      "balanced",
      "turbo",
      "max",
      "max_plus",
      "custom",
      "gentle",
    ];
    expect(tagged(Vacuum, speeds).map((mode) => mode.mode)).toEqual([
      0,
      ...speeds.map((_speed, index) => 10 + index),
    ]);
    expect(
      tagged(Max, speeds, { turbo: Max, max: Max }).map((mode) => mode.label),
    ).toEqual(["Turbo", "Max"]);
    expect(
      tagged(Max, speeds, { custom: Max }).map((mode) => mode.label),
    ).toEqual(["Custom"]);
  });
  it("preserves unique buckets and deterministic first matches for noncanonical names", () => {
    expect(tagged(Quiet, ["low", "standard", "high"])[0].label).toBe("Low");
    expect(tagged(Max, ["low", "standard", "high"])[0].label).toBe("High");
    expect(tagged(Max, ["strong", "boost"])[0].label).toBe("Strong");
  });
});
