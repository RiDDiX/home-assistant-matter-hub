import { describe, expect, it } from "vitest";
import {
  decideWedgeRotation,
  decideWedgeRotationV2,
  WEDGE_IM_SILENCE_MS,
  WEDGE_MIN_ROTATE_INTERVAL_MS,
  WEDGE_V2_COMMAND_SILENCE_MS,
  WEDGE_V2_MIN_GIVE_UPS,
  WEDGE_V2_MIN_SUBSCRIBES,
  WEDGE_V2_WINDOW_MS,
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

// V2 shadow rule: command silence plus a subscribe/give-up churn pattern in
// the last 30min. Fixed clock so window edges are exact.
const NOW = 1_750_000_000_000;
const min = 60_000;

// Full wedge cycle: silent on commands, controller keeps re-subscribing and
// the server keeps giving up on delivery afterwards.
const v2Wedged = {
  subscriptionCount: 1,
  sessionAgeMs: WEDGE_V2_COMMAND_SILENCE_MS + WEDGE_WARMUP_MS + 1,
  commandSilenceMs: WEDGE_V2_COMMAND_SILENCE_MS + 1,
  subscribeTimesMs: [NOW - 25 * min, NOW - 20 * min, NOW - 15 * min],
  giveUpTimesMs: [NOW - 10 * min, NOW - 5 * min],
  nowMs: NOW,
  lastRotatedMsAgo: null as number | null,
};

describe("decideWedgeRotationV2", () => {
  it("rotates a full wedge cycle", () => {
    expect(decideWedgeRotationV2(v2Wedged)).toBe(true);
  });

  it("keeps a healthy sensor-only session (no subscribes, no give-ups)", () => {
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        subscribeTimesMs: [],
        giveUpTimesMs: [],
      }),
    ).toBe(false);
  });

  it("keeps a recovery burst (no give-up after the newest subscribe)", () => {
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        giveUpTimesMs: [NOW - 28 * min, NOW - 27 * min],
        subscribeTimesMs: [NOW - 25 * min, NOW - 20 * min, NOW - 15 * min],
      }),
    ).toBe(false);
  });

  it("keeps a departed phone (give-ups, no subscribes)", () => {
    expect(decideWedgeRotationV2({ ...v2Wedged, subscribeTimesMs: [] })).toBe(
      false,
    );
  });

  it("keeps a session with no subscriptions", () => {
    expect(decideWedgeRotationV2({ ...v2Wedged, subscriptionCount: 0 })).toBe(
      false,
    );
  });

  it("keeps a session exactly at the warmup boundary (strict >)", () => {
    expect(
      decideWedgeRotationV2({ ...v2Wedged, sessionAgeMs: WEDGE_WARMUP_MS }),
    ).toBe(false);
  });

  it("keeps a session exactly at the command silence threshold (strict >)", () => {
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        commandSilenceMs: WEDGE_V2_COMMAND_SILENCE_MS,
      }),
    ).toBe(false);
  });

  it("keeps a session with a recent command", () => {
    expect(
      decideWedgeRotationV2({ ...v2Wedged, commandSilenceMs: 1_000 }),
    ).toBe(false);
  });

  it("falls back to session age when no command was ever stamped", () => {
    expect(decideWedgeRotationV2({ ...v2Wedged, commandSilenceMs: null })).toBe(
      true,
    );
  });

  it("keeps a never-commanded session that is still young enough", () => {
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        commandSilenceMs: null,
        sessionAgeMs: WEDGE_WARMUP_MS + 1,
      }),
    ).toBe(false);
  });

  it("requires at least 3 subscribes inside the window", () => {
    expect(WEDGE_V2_MIN_SUBSCRIBES).toBe(3);
    // Third subscribe just past the window leaves only two that count.
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        subscribeTimesMs: [
          NOW - WEDGE_V2_WINDOW_MS - 1,
          NOW - 20 * min,
          NOW - 15 * min,
        ],
      }),
    ).toBe(false);
  });

  it("counts a subscribe sitting exactly on the window edge", () => {
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        subscribeTimesMs: [
          NOW - WEDGE_V2_WINDOW_MS,
          NOW - 20 * min,
          NOW - 15 * min,
        ],
      }),
    ).toBe(true);
  });

  it("requires at least 2 give-ups inside the window", () => {
    expect(WEDGE_V2_MIN_GIVE_UPS).toBe(2);
    expect(
      decideWedgeRotationV2({ ...v2Wedged, giveUpTimesMs: [NOW - 5 * min] }),
    ).toBe(false);
  });

  it("ignores give-ups older than the window", () => {
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        giveUpTimesMs: [
          NOW - WEDGE_V2_WINDOW_MS - 2 * min,
          NOW - WEDGE_V2_WINDOW_MS - 1,
        ],
      }),
    ).toBe(false);
  });

  it("requires the newest give-up to be strictly newer than some subscribe", () => {
    // Tie with the oldest in-window subscribe is not newer.
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        subscribeTimesMs: [NOW - 10 * min, NOW - 8 * min, NOW - 6 * min],
        giveUpTimesMs: [NOW - 12 * min, NOW - 10 * min],
      }),
    ).toBe(false);
  });

  it("throttles a repeat rotation inside the minimum interval", () => {
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        lastRotatedMsAgo: WEDGE_MIN_ROTATE_INTERVAL_MS,
      }),
    ).toBe(false);
  });

  it("rotates again once past the minimum interval", () => {
    expect(
      decideWedgeRotationV2({
        ...v2Wedged,
        lastRotatedMsAgo: WEDGE_MIN_ROTATE_INTERVAL_MS + 1,
      }),
    ).toBe(true);
  });
});
