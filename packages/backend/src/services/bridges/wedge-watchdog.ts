// Wedge watchdog: rotate exactly the session that looks wedged, earlier than
// the blind 4h rotation. An Apple controller can keep MRP-acking pushed reports
// (so activeTimestamp/isPeerActive stay fresh) while it has stopped consuming
// data and stopped sending any inbound Interaction Model request. The only
// controller-side signal that survives that state is the absence of inbound IM
// requests, so the rule keys on that alone.

export const WEDGE_WARMUP_MS = 15 * 60 * 1000;
export const WEDGE_IM_SILENCE_MS = 45 * 60 * 1000;
export const WEDGE_MIN_ROTATE_INTERVAL_MS = 60 * 60 * 1000;

export interface WedgeInput {
  subscriptionCount: number;
  sessionAgeMs: number;
  // ms since the last inbound IM request, or null when one was never seen.
  lastImRequestMsAgo: number | null;
  // ms since this session was last rotated by the watchdog, or null if never.
  lastRotatedMsAgo: number | null;
}

// Pure decision: is this session wedged enough to rotate right now?
// Never read isPeerActive/activeTimestamp/lastActiveMsAgo here. Those advance on
// MRP acks even while the controller has gone silent, so keying on them recreates
// the #398 false-recovery trap.
export function decideWedgeRotation(input: WedgeInput): boolean {
  const {
    subscriptionCount,
    sessionAgeMs,
    lastImRequestMsAgo,
    lastRotatedMsAgo,
  } = input;
  const imSilenceMs =
    lastImRequestMsAgo == null ? sessionAgeMs : lastImRequestMsAgo;
  return (
    subscriptionCount > 0 &&
    sessionAgeMs > WEDGE_WARMUP_MS &&
    imSilenceMs > WEDGE_IM_SILENCE_MS &&
    (lastRotatedMsAgo == null ||
      lastRotatedMsAgo > WEDGE_MIN_ROTATE_INTERVAL_MS)
  );
}
