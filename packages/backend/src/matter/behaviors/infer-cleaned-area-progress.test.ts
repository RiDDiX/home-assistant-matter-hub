import { describe, expect, it } from "vitest";
import { inferCleanedAreaProgress } from "./infer-cleaned-area-progress.js";

const rooms = [
  { areaId: 1, sizeSqm: 10 },
  { areaId: 2, sizeSqm: 20 },
  { areaId: 3, sizeSqm: 30 },
];

describe("inferCleanedAreaProgress (#368)", () => {
  it("tracks the current room as cleaned area grows", () => {
    expect(inferCleanedAreaProgress(0, rooms)).toEqual({
      currentArea: 1,
      completed: [],
    });
    expect(inferCleanedAreaProgress(5, rooms)).toEqual({
      currentArea: 1,
      completed: [],
    });
    // exact end of room 1 completes it (strict less-than)
    expect(inferCleanedAreaProgress(10, rooms)).toEqual({
      currentArea: 2,
      completed: [1],
    });
    expect(inferCleanedAreaProgress(12, rooms)).toEqual({
      currentArea: 2,
      completed: [1],
    });
    expect(inferCleanedAreaProgress(30, rooms)).toEqual({
      currentArea: 3,
      completed: [1, 2],
    });
    expect(inferCleanedAreaProgress(45, rooms)).toEqual({
      currentArea: 3,
      completed: [1, 2],
    });
  });

  it("returns null current once the whole area is covered", () => {
    expect(inferCleanedAreaProgress(60, rooms)).toEqual({
      currentArea: null,
      completed: [1, 2, 3],
    });
    expect(inferCleanedAreaProgress(999, rooms)).toEqual({
      currentArea: null,
      completed: [1, 2, 3],
    });
  });

  it("clamps negative and non-finite cleaned area to the first room", () => {
    expect(inferCleanedAreaProgress(-5, rooms)).toEqual({
      currentArea: 1,
      completed: [],
    });
    expect(inferCleanedAreaProgress(Number.NaN, rooms)).toEqual({
      currentArea: 1,
      completed: [],
    });
  });

  it("handles a single room", () => {
    const one = [{ areaId: 5, sizeSqm: 10 }];
    expect(inferCleanedAreaProgress(5, one)).toEqual({
      currentArea: 5,
      completed: [],
    });
    expect(inferCleanedAreaProgress(10, one)).toEqual({
      currentArea: null,
      completed: [5],
    });
  });

  it("skips zero-size and non-finite-size rooms", () => {
    const mixed = [
      { areaId: 1, sizeSqm: 0 },
      { areaId: 2, sizeSqm: 10 },
      { areaId: 3, sizeSqm: 0 },
      { areaId: 4, sizeSqm: 5 },
    ];
    expect(inferCleanedAreaProgress(3, mixed)).toEqual({
      currentArea: 2,
      completed: [1],
    });
    const bad = [
      { areaId: 1, sizeSqm: 10 },
      { areaId: 2, sizeSqm: Number.NaN },
      { areaId: 3, sizeSqm: 5 },
    ];
    expect(inferCleanedAreaProgress(12, bad)).toEqual({
      currentArea: 3,
      completed: [1, 2],
    });
  });

  it("returns null for an empty selection", () => {
    expect(inferCleanedAreaProgress(5, [])).toEqual({
      currentArea: null,
      completed: [],
    });
  });
});
