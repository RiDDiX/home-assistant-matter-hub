// Shared age-based Matter session rotation helpers (#287). Rotating a
// controller's CASE session makes it re-establish and re-subscribe, which
// clears wedged subscription state. Used by both the aggregator Bridge and
// the ServerModeBridge.

import type { BridgeFeatureFlags } from "@home-assistant-matter-hub/common";
import { Time } from "@matter/general";

// 0 = off, age rotation is opt-in on every bridge (#287).
export const DEFAULT_SESSION_MAX_AGE_HOURS = 0;
export const SESSION_MAX_AGE_HOURS_RANGE = { min: 1, max: 168 };
export const ROTATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Returns the parsed hours, 0 (disabled), or null when the raw value is
// malformed and the caller should log + fall back to the default.
export function parseSessionMaxAgeHours(
  raw: string | undefined | null,
): number | null {
  if (raw == null || raw === "") return DEFAULT_SESSION_MAX_AGE_HOURS;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return null;
  if (n === 0) return 0;
  const { min, max } = SESSION_MAX_AGE_HOURS_RANGE;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// When all subscriptions are lost but sessions remain active, wait this
// long before force-closing the dead sessions. This breaks the deadlock
// where the controller holds a stale CASE session and never re-subscribes
// because it doesn't know the server canceled its subscriptions (#266).
export const DEAD_SESSION_TIMEOUT_MS = 60_000;

// fastSessionRecovery: drop the dead session after 5s, not 60s (#386).
// Keep a few seconds so a normal re-subscribe isn't cut off.
export const FAST_DEAD_SESSION_TIMEOUT_MS = 5_000;

export function deadSessionTimeoutMs(flags?: BridgeFeatureFlags): number {
  return flags?.fastSessionRecovery
    ? FAST_DEAD_SESSION_TIMEOUT_MS
    : DEAD_SESSION_TIMEOUT_MS;
}

// How long a 0-sub session must be fully silent before it counts as dead.
// isPeerActive alone only covers ~4s of received traffic, which closed
// briefly-quiet Apple hub sessions and wedged them on "Updating..." (#398).
export const STALE_SESSION_QUIET_WINDOW_MS = 5 * 60 * 1000;

// A controller can spend 10s or more streaming its priming report, and it
// holds no subscription until that finishes. Sessions replaced by a new CASE
// session wait at least this long, even under fastSessionRecovery, so an
// interview is never cut short (#424).
export const PRIMING_GRACE_MS = 30_000;

export function replacedSessionTimeoutMs(flags?: BridgeFeatureFlags): number {
  return Math.max(deadSessionTimeoutMs(flags), PRIMING_GRACE_MS);
}

// fastSessionRecovery users opted into aggressive cleanup (#386),
// keep their behavior exactly as it is today.
export function staleSessionQuietWindowMs(flags?: BridgeFeatureFlags): number {
  return flags?.fastSessionRecovery ? 0 : STALE_SESSION_QUIET_WINDOW_MS;
}

// A 0-subscription session is only dead once the peer stops talking for a
// real quiet window (session.timestamp covers traffic in both directions),
// not just the ~4s isPeerActive covers. Keeping it lets the controller
// re-subscribe on it instead of being forced offline (#287/#398); a truly
// dead session has a frozen timestamp and still closes via the re-arm
// loops (#266/#105).
// True once a session is not closing, its peer stopped talking, and its last
// traffic is past the quiet window (#287/#398).
export function sessionIsQuiet(
  session: {
    isClosing: boolean;
    isPeerActive: boolean;
    timestamp?: number;
  },
  quietWindowMs = STALE_SESSION_QUIET_WINDOW_MS,
  // session.timestamp runs on matter.js's monotonic clock, not Date.now()
  now: number = Time.nowUs,
): boolean {
  if (session.isClosing) return false;
  if (session.isPeerActive) return false;
  if (
    quietWindowMs > 0 &&
    typeof session.timestamp === "number" &&
    now - session.timestamp < quietWindowMs
  ) {
    // Recent traffic, the peer may still re-subscribe on this session.
    return false;
  }
  return true;
}

export function staleSessionShouldClose(
  session: {
    subscriptions: { size: number };
    isClosing: boolean;
    isPeerActive: boolean;
    timestamp?: number;
  },
  quietWindowMs = STALE_SESSION_QUIET_WINDOW_MS,
  now: number = Time.nowUs,
): boolean {
  return (
    session.subscriptions.size === 0 &&
    sessionIsQuiet(session, quietWindowMs, now)
  );
}

export function seedExistingSessionStarts(
  startedAt: Map<number, number>,
  sessions: Iterable<{ id: number }>,
  now = Date.now(),
): void {
  for (const session of sessions) {
    if (!startedAt.has(session.id)) {
      startedAt.set(session.id, now);
    }
  }
}
