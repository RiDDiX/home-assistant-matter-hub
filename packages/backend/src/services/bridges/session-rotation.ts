// Shared age-based Matter session rotation helpers (#287). Rotating a
// controller's CASE session makes it re-establish and re-subscribe, which
// clears wedged subscription state. Used by both the aggregator Bridge and
// the ServerModeBridge.

import type { BridgeFeatureFlags } from "@home-assistant-matter-hub/common";

export const DEFAULT_SESSION_MAX_AGE_HOURS = 4;
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

// How long a 0-sub session must be fully silent before it counts as dead.
// isPeerActive alone only covers ~4s of received traffic, which closed
// briefly-quiet Apple hub sessions and wedged them on "Updating..." (#398).
export const STALE_SESSION_QUIET_WINDOW_MS = 5 * 60 * 1000;

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
// traffic is past the quiet window. Shared by the 0-sub stale check and the
// superseded-session sweep so both agree on what "quiet" means (#287/#398).
export function sessionIsQuiet(
  session: {
    isClosing: boolean;
    isPeerActive: boolean;
    timestamp?: number;
  },
  quietWindowMs = STALE_SESSION_QUIET_WINDOW_MS,
  now = Date.now(),
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
  now = Date.now(),
): boolean {
  return (
    session.subscriptions.size === 0 &&
    sessionIsQuiet(session, quietWindowMs, now)
  );
}

// A peer that re-CASEs leaves its old sessions behind. The #105 loop only
// force-closes the 0-sub ones; sessions still holding a dead subscription
// escaped every cleanup path and piled up 160 deep for one flapping Echo
// (#400). Returns superseded sessions for the same peer+fabric that have
// gone quiet, regardless of subscription count.
export function selectSupersededSessions(
  sessions: Iterable<{
    id: number;
    peerNodeId: unknown;
    fabric?: { fabricIndex?: unknown };
    isClosing: boolean;
    isPeerActive: boolean;
    timestamp?: number;
    subscriptions: { size: number };
  }>,
  newSession: {
    id: number;
    peerNodeId: unknown;
    fabric?: { fabricIndex?: unknown };
  },
  quietWindowMs = STALE_SESSION_QUIET_WINDOW_MS,
  now = Date.now(),
): number[] {
  const ids: number[] = [];
  for (const s of sessions) {
    if (
      s.id !== newSession.id &&
      s.peerNodeId === newSession.peerNodeId &&
      s.fabric?.fabricIndex === newSession.fabric?.fabricIndex &&
      !s.isClosing &&
      sessionIsQuiet(s, quietWindowMs, now)
    ) {
      ids.push(s.id);
    }
  }
  return ids;
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
