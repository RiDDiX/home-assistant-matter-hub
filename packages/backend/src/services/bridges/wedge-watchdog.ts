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

// V2 (#365, shadow): the v1 rule fires on any IM silence, but a controller
// that only polls sensors is legitimately command-silent. V2 instead demands
// the full wedge signature: no command-class request for a long time while the
// controller keeps re-subscribing and the server keeps giving up on report
// delivery afterwards.
export const WEDGE_V2_COMMAND_SILENCE_MS = 45 * 60 * 1000;
export const WEDGE_V2_WINDOW_MS = 30 * 60 * 1000;
export const WEDGE_V2_MIN_SUBSCRIBES = 3;
export const WEDGE_V2_MIN_GIVE_UPS = 2;

// Ring size for the per-session subscribe and give-up timestamp rings.
export const WEDGE_RING_SIZE = 10;

// A peer cancel lands with an inbound IM stamp within milliseconds; a server
// delivery give-up has no coincident inbound. Anything stamped within this
// window before the sub termination counts as a peer cancel, not a give-up.
export const WEDGE_GIVE_UP_QUIET_MS = 5_000;

export interface WedgeInputV2 {
  subscriptionCount: number;
  sessionAgeMs: number;
  // ms since the last inbound Read/Write/Invoke/Timed request, or null when
  // one was never seen.
  commandSilenceMs: number | null;
  // Inbound SubscribeRequest times (epoch ms).
  subscribeTimesMs: number[];
  // Server-side subscription give-up times (epoch ms).
  giveUpTimesMs: number[];
  nowMs: number;
  lastRotatedMsAgo: number | null;
}

// Timestamps still inside the activity window, edge inclusive.
function inWindow(timesMs: number[], nowMs: number): number[] {
  return timesMs.filter((t) => nowMs - t <= WEDGE_V2_WINDOW_MS);
}

export function countRecent(timesMs: number[], nowMs: number): number {
  return inWindow(timesMs, nowMs).length;
}

export function decideWedgeRotationV2(input: WedgeInputV2): boolean {
  const silenceMs = input.commandSilenceMs ?? input.sessionAgeMs;
  if (input.subscriptionCount <= 0) return false;
  if (input.sessionAgeMs <= WEDGE_WARMUP_MS) return false;
  if (silenceMs <= WEDGE_V2_COMMAND_SILENCE_MS) return false;
  const subscribes = inWindow(input.subscribeTimesMs, input.nowMs);
  const giveUps = inWindow(input.giveUpTimesMs, input.nowMs);
  if (subscribes.length < WEDGE_V2_MIN_SUBSCRIBES) return false;
  if (giveUps.length < WEDGE_V2_MIN_GIVE_UPS) return false;
  // Delivery must still be failing after the controller's latest retry: the
  // newest give-up has to postdate at least one in-window subscribe.
  if (Math.max(...giveUps) <= Math.min(...subscribes)) return false;
  return (
    input.lastRotatedMsAgo == null ||
    input.lastRotatedMsAgo > WEDGE_MIN_ROTATE_INTERVAL_MS
  );
}
