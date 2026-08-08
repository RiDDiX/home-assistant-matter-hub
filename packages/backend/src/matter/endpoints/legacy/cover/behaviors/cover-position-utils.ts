import type { BridgeFeatureFlags } from "@home-assistant-matter-hub/common";

/**
 * Inversion is its own inverse (100 - (100 - x) === x), so read and write
 * share the same body. Both exported names stay for callers that distinguish
 * them at the call site; the shared helper is the single source of truth.
 */
function adjustPosition(
  position: number,
  flags: BridgeFeatureFlags | undefined,
  matterSemantics: boolean,
): number | null {
  if (position == null) {
    return null;
  }

  const skipInversion =
    flags?.coverDoNotInvertPercentage === true ||
    flags?.coverUseHomeAssistantPercentage === true ||
    matterSemantics;

  if (flags?.coverSwapOpenClose === true && !skipInversion) {
    return position;
  }

  if (!skipInversion) {
    return 100 - position;
  }

  return position;
}

/**
 * Adjust cover position when READING from HA to report to Matter.
 */
export function adjustPositionForReading(
  position: number,
  flags: BridgeFeatureFlags | undefined,
  matterSemantics: boolean,
): number | null {
  return adjustPosition(position, flags, matterSemantics);
}

/**
 * Adjust cover position when WRITING from Matter to HA.
 */
export function adjustPositionForWriting(
  position: number,
  flags: BridgeFeatureFlags | undefined,
  matterSemantics: boolean,
): number | null {
  return adjustPosition(position, flags, matterSemantics);
}
