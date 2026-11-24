import {
  type BridgeFeatureFlags,
  isCoverPositionInverted,
} from "@home-assistant-matter-hub/common";

/**
 * Converts a cover percent between HA and Matter. Inversion is its own inverse
 * (100 - (100 - x) === x), so reading and writing share this one function.
 */
export function adjustPosition(
  position: number,
  flags: BridgeFeatureFlags | undefined,
): number {
  return isCoverPositionInverted(flags) ? 100 - position : position;
}
