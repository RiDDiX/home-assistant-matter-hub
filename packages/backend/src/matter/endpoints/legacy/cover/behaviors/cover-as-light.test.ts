import {
  CoverSupportedFeatures,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import {
  coverLevelAction,
  coverOpenness,
  tiltOpenClose,
} from "./cover-as-light.js";

function state(
  value: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityState {
  return {
    entity_id: "cover.test",
    state: value,
    attributes,
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

describe("coverOpenness", () => {
  it("uses current_position as the openness fraction", () => {
    expect(coverOpenness(state("open", { current_position: 50 }))).toBe(0.5);
    expect(coverOpenness(state("open", { current_position: 100 }))).toBe(1);
    expect(coverOpenness(state("closed", { current_position: 0 }))).toBe(0);
  });

  it("falls back to current_tilt_position for tilt-only covers", () => {
    expect(coverOpenness(state("open", { current_tilt_position: 100 }))).toBe(
      1,
    );
    expect(coverOpenness(state("closed", { current_tilt_position: 0 }))).toBe(
      0,
    );
  });

  it("falls back to the open/closed state when there is no position", () => {
    expect(coverOpenness(state("open"))).toBe(1);
    expect(coverOpenness(state("closed"))).toBe(0);
    expect(coverOpenness(state("opening"))).toBeNull();
  });
});

describe("coverLevelAction", () => {
  const LIFT_POSITION = CoverSupportedFeatures.support_set_position;
  const LIFT_BINARY =
    CoverSupportedFeatures.support_open | CoverSupportedFeatures.support_close;
  // SwitchBot Blind Tilt and friends: tilt only, no lift support (#350).
  const TILT_POSITION =
    CoverSupportedFeatures.support_open_tilt |
    CoverSupportedFeatures.support_close_tilt |
    CoverSupportedFeatures.support_set_tilt_position;
  const TILT_BINARY =
    CoverSupportedFeatures.support_open_tilt |
    CoverSupportedFeatures.support_close_tilt;

  it("maps the level to set_cover_position when position is supported", () => {
    expect(coverLevelAction(0.5, LIFT_POSITION)).toEqual({
      action: "cover.set_cover_position",
      data: { position: 50 },
    });
  });

  it("maps the level to open/close for lift covers without position support", () => {
    expect(coverLevelAction(0.8, LIFT_BINARY)).toEqual({
      action: "cover.open_cover",
    });
    expect(coverLevelAction(0.2, LIFT_BINARY)).toEqual({
      action: "cover.close_cover",
    });
  });

  it("drives a tilt-only cover via tilt position (#350)", () => {
    expect(coverLevelAction(0.7, TILT_POSITION)).toEqual({
      action: "cover.set_cover_tilt_position",
      data: { tilt_position: 70 },
    });
  });

  it("drives a tilt-only cover without tilt position via open/close tilt", () => {
    expect(coverLevelAction(0.8, TILT_BINARY)).toEqual({
      action: "cover.open_cover_tilt",
    });
    expect(coverLevelAction(0.2, TILT_BINARY)).toEqual({
      action: "cover.close_cover_tilt",
    });
  });
});

describe("tiltOpenClose (#405)", () => {
  // A set-tilt-position-only cover lacks the discrete tilt services, so on/off
  // must go through set_cover_tilt_position, not open_cover_tilt.
  const TILT_POSITION_ONLY = CoverSupportedFeatures.support_set_tilt_position;
  const TILT_BINARY =
    CoverSupportedFeatures.support_open_tilt |
    CoverSupportedFeatures.support_close_tilt;

  it("uses set_cover_tilt_position for a set-tilt-position-only cover", () => {
    expect(tiltOpenClose(true, TILT_POSITION_ONLY)).toEqual({
      action: "cover.set_cover_tilt_position",
      data: { tilt_position: 100 },
    });
    expect(tiltOpenClose(false, TILT_POSITION_ONLY)).toEqual({
      action: "cover.set_cover_tilt_position",
      data: { tilt_position: 0 },
    });
  });

  it("uses the discrete tilt services when the cover has them", () => {
    expect(tiltOpenClose(true, TILT_BINARY)).toEqual({
      action: "cover.open_cover_tilt",
    });
    expect(tiltOpenClose(false, TILT_BINARY)).toEqual({
      action: "cover.close_cover_tilt",
    });
  });
});
