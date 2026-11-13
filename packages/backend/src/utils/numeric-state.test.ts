import { describe, expect, it } from "vitest";
import { numericState } from "./numeric-state.js";

describe("numericState", () => {
  it.each([
    ["21", 21],
    ["0", 0],
    ["-4.5", -4.5],
    ["0.25", 0.25],
    [" 7 ", 7],
    [12, 12],
    [0, 0],
  ])("reads %j as %j", (input, expected) => {
    expect(numericState(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    [" "],
    ["\t"],
    ["unknown"],
    ["unavailable"],
    ["Infinity"],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
  ])("reads %j as null", (input) => {
    expect(numericState(input)).toBeNull();
  });
});
