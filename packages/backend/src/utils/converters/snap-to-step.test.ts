import { describe, expect, it } from "vitest";
import { snapToStep } from "./snap-to-step.js";

describe("snapToStep", () => {
  it("rounds +0.5 step up when nudging up from current", () => {
    expect(snapToStep(20.5, 20, 1)).toBe(21);
  });

  it("rounds -0.5 step down when nudging down from current", () => {
    expect(snapToStep(19.5, 20, 1)).toBe(19);
  });

  it("snaps to nearest step for non-tie deltas", () => {
    expect(snapToStep(20.3, 20, 1)).toBe(20);
    expect(snapToStep(20.7, 20, 1)).toBe(21);
    expect(snapToStep(19.7, 20, 1)).toBe(20);
    expect(snapToStep(19.2, 20, 1)).toBe(19);
  });

  it("returns target unchanged when already on the grid", () => {
    expect(snapToStep(20, 20, 1)).toBe(20);
    expect(snapToStep(21, 20, 1)).toBe(21);
  });

  it("passes through when step is missing", () => {
    expect(snapToStep(20.5, 20, undefined)).toBe(20.5);
  });

  it("passes through for non-positive or non-finite step", () => {
    expect(snapToStep(20.5, 20, 0)).toBe(20.5);
    expect(snapToStep(20.5, 20, -1)).toBe(20.5);
    expect(snapToStep(20.5, 20, Number.NaN)).toBe(20.5);
  });

  it("uses upper neighbor on ties when current is unknown", () => {
    expect(snapToStep(20.5, undefined, 1)).toBe(21);
  });

  it("respects 0.5 steps", () => {
    expect(snapToStep(20.5, 20, 0.5)).toBe(20.5);
    expect(snapToStep(20.1, 20, 0.5)).toBe(20);
    expect(snapToStep(19.75, 20, 0.5)).toBe(19.5);
  });

  it("works in fahrenheit (no special-casing)", () => {
    expect(snapToStep(68.5, 68, 1)).toBe(69);
    expect(snapToStep(67.5, 68, 1)).toBe(67);
  });
});
