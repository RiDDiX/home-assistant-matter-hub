import { describe, expect, it } from "vitest";
import { makeWarmStartState } from "./server-mode-bridge.js";
import {
  DEFAULT_SESSION_MAX_AGE_HOURS,
  parseSessionMaxAgeHours,
  SESSION_MAX_AGE_HOURS_RANGE,
  STALE_SESSION_QUIET_WINDOW_MS,
  seedExistingSessionStarts,
  staleSessionQuietWindowMs,
  staleSessionShouldClose,
} from "./session-rotation.js";

describe("staleSessionShouldClose", () => {
  const session = (
    over: Partial<Parameters<typeof staleSessionShouldClose>[0]>,
  ) => ({
    subscriptions: { size: 0 },
    isClosing: false,
    isPeerActive: false,
    ...over,
  });

  it("closes a 0-sub session whose peer has gone quiet", () => {
    expect(staleSessionShouldClose(session({ isPeerActive: false }))).toBe(
      true,
    );
  });

  it("keeps a 0-sub session whose peer is still active (#287)", () => {
    expect(staleSessionShouldClose(session({ isPeerActive: true }))).toBe(
      false,
    );
  });

  it("keeps a session that still has subscriptions", () => {
    expect(
      staleSessionShouldClose(session({ subscriptions: { size: 2 } })),
    ).toBe(false);
  });

  it("keeps a session that is already closing", () => {
    expect(staleSessionShouldClose(session({ isClosing: true }))).toBe(false);
  });

  // #398: isPeerActive only covers ~4s, so a hub session with traffic 94s
  // ago was closed and Apple Home wedged on "Updating...". Recent traffic
  // must keep the session alive.
  const NOW = 1_750_000_000_000;

  it("keeps a session with recent traffic (#398)", () => {
    expect(
      staleSessionShouldClose(
        session({ timestamp: NOW - 94_000 }),
        STALE_SESSION_QUIET_WINDOW_MS,
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps a session just inside the quiet window", () => {
    expect(
      staleSessionShouldClose(
        session({ timestamp: NOW - STALE_SESSION_QUIET_WINDOW_MS + 1 }),
        STALE_SESSION_QUIET_WINDOW_MS,
        NOW,
      ),
    ).toBe(false);
  });

  it("closes a session silent for the whole quiet window", () => {
    expect(
      staleSessionShouldClose(
        session({ timestamp: NOW - STALE_SESSION_QUIET_WINDOW_MS }),
        STALE_SESSION_QUIET_WINDOW_MS,
        NOW,
      ),
    ).toBe(true);
  });

  it("ignores the window when it is 0 (fastSessionRecovery)", () => {
    expect(
      staleSessionShouldClose(session({ timestamp: NOW - 1_000 }), 0, NOW),
    ).toBe(true);
  });
});

describe("staleSessionQuietWindowMs", () => {
  it("uses the quiet window by default", () => {
    expect(staleSessionQuietWindowMs(undefined)).toBe(
      STALE_SESSION_QUIET_WINDOW_MS,
    );
    expect(staleSessionQuietWindowMs({})).toBe(STALE_SESSION_QUIET_WINDOW_MS);
    expect(staleSessionQuietWindowMs({ fastSessionRecovery: false })).toBe(
      STALE_SESSION_QUIET_WINDOW_MS,
    );
  });

  it("drops the window for fastSessionRecovery (#386)", () => {
    expect(staleSessionQuietWindowMs({ fastSessionRecovery: true })).toBe(0);
  });
});

describe("parseSessionMaxAgeHours", () => {
  it("returns the default when raw is undefined", () => {
    expect(parseSessionMaxAgeHours(undefined)).toBe(
      DEFAULT_SESSION_MAX_AGE_HOURS,
    );
  });

  it("returns the default when raw is null", () => {
    expect(parseSessionMaxAgeHours(null)).toBe(DEFAULT_SESSION_MAX_AGE_HOURS);
  });

  it("returns the default when raw is an empty string", () => {
    expect(parseSessionMaxAgeHours("")).toBe(DEFAULT_SESSION_MAX_AGE_HOURS);
  });

  it("returns null on a non-numeric string so caller can warn", () => {
    expect(parseSessionMaxAgeHours("abc")).toBeNull();
  });

  it("returns null on a negative integer so caller can warn", () => {
    expect(parseSessionMaxAgeHours("-1")).toBeNull();
  });

  it("returns 0 for the disable sentinel", () => {
    expect(parseSessionMaxAgeHours("0")).toBe(0);
  });

  it("clamps values below the lower bound to the minimum", () => {
    // Anything between 1 and min would round up; explicit min check.
    expect(
      parseSessionMaxAgeHours(String(SESSION_MAX_AGE_HOURS_RANGE.min)),
    ).toBe(SESSION_MAX_AGE_HOURS_RANGE.min);
  });

  it("clamps values above the upper bound to the maximum", () => {
    expect(
      parseSessionMaxAgeHours(String(SESSION_MAX_AGE_HOURS_RANGE.max + 1)),
    ).toBe(SESSION_MAX_AGE_HOURS_RANGE.max);
  });

  it("passes valid values through unchanged", () => {
    expect(parseSessionMaxAgeHours("4")).toBe(4);
    expect(parseSessionMaxAgeHours("24")).toBe(24);
    expect(parseSessionMaxAgeHours("168")).toBe(168);
  });

  it("parses leading-digit strings like Number.parseInt does", () => {
    // Mirrors Number.parseInt behaviour (existing semantics, not new).
    expect(parseSessionMaxAgeHours("12abc")).toBe(12);
  });
});

describe("seedExistingSessionStarts", () => {
  it("adds existing sessions that were restored before diagnostics were wired", () => {
    const startedAt = new Map<number, number>([[1, 1000]]);

    seedExistingSessionStarts(
      startedAt,
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      5000,
    );

    expect(startedAt.get(1)).toBe(1000);
    expect(startedAt.get(2)).toBe(5000);
    expect(startedAt.get(3)).toBe(5000);
  });
});

describe("makeWarmStartState", () => {
  it("forces a structural state change while preserving existing values", () => {
    const current = {
      state: "docked",
      attributes: { battery_level: 100 },
      last_updated: "old",
    };

    const next = makeWarmStartState(current, "new");

    expect(next).toEqual({
      state: "docked",
      attributes: { battery_level: 100 },
      last_updated: "new",
    });
    expect(next).not.toBe(current);
  });
});
