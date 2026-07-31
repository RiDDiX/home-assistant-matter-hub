import { describe, expect, it } from "vitest";
import {
  decideWedgeRotation,
  WEDGE_IM_SILENCE_MS,
  WEDGE_MIN_ROTATE_INTERVAL_MS,
  WEDGE_WARMUP_MS,
} from "./wedge-watchdog.js";

// Baseline input that would trigger a rotation; each case overrides one field
// so a single failing property is obvious.
const wedged = {
  subscriptionCount: 1,
  sessionAgeMs: WEDGE_WARMUP_MS + WEDGE_IM_SILENCE_MS + 1,
  lastImRequestMsAgo: WEDGE_IM_SILENCE_MS + 1,
  lastRotatedMsAgo: null as number | null,
};

describe("decideWedgeRotation", () => {
  it("rotates a warmed, IM-silent session with subscriptions", () => {
    expect(decideWedgeRotation(wedged)).toBe(true);
  });

  it("keeps a healthy idle young session (still in warmup)", () => {
    expect(
      decideWedgeRotation({ ...wedged, sessionAgeMs: WEDGE_WARMUP_MS - 1 }),
    ).toBe(false);
  });

  it("keeps a session exactly at the warmup boundary (strict >)", () => {
    expect(
      decideWedgeRotation({ ...wedged, sessionAgeMs: WEDGE_WARMUP_MS }),
    ).toBe(false);
  });

  it("keeps a session with a recent inbound IM request", () => {
    expect(decideWedgeRotation({ ...wedged, lastImRequestMsAgo: 1_000 })).toBe(
      false,
    );
  });

  it("keeps a session at exactly the IM silence threshold", () => {
    expect(
      decideWedgeRotation({
        ...wedged,
        lastImRequestMsAgo: WEDGE_IM_SILENCE_MS,
      }),
    ).toBe(false);
  });

  it("does not rotate a session with no subscriptions", () => {
    expect(decideWedgeRotation({ ...wedged, subscriptionCount: 0 })).toBe(
      false,
    );
  });

  it("throttles a repeat rotation inside the minimum interval", () => {
    expect(
      decideWedgeRotation({
        ...wedged,
        lastRotatedMsAgo: WEDGE_MIN_ROTATE_INTERVAL_MS - 1,
      }),
    ).toBe(false);
  });

  it("throttles a repeat rotation exactly at the minimum interval (strict >)", () => {
    expect(
      decideWedgeRotation({
        ...wedged,
        lastRotatedMsAgo: WEDGE_MIN_ROTATE_INTERVAL_MS,
      }),
    ).toBe(false);
  });

  it("rotates again once past the minimum interval", () => {
    expect(
      decideWedgeRotation({
        ...wedged,
        lastRotatedMsAgo: WEDGE_MIN_ROTATE_INTERVAL_MS + 1,
      }),
    ).toBe(true);
  });

  it("falls back to session age when the IM request was never stamped", () => {
    // Never any inbound IM and the session is old enough: treat as wedged.
    expect(
      decideWedgeRotation({
        ...wedged,
        lastImRequestMsAgo: null,
        sessionAgeMs: WEDGE_IM_SILENCE_MS + 1,
      }),
    ).toBe(true);
  });

  it("keeps a never-stamped session that is still young enough", () => {
    expect(
      decideWedgeRotation({
        ...wedged,
        lastImRequestMsAgo: null,
        sessionAgeMs: WEDGE_WARMUP_MS + 1,
      }),
    ).toBe(false);
  });
});
