// Home Assistant exposes no canonical speed ranking for climate fan_modes (or
// fan preset_modes), and many devices, SmartIR / Broadlink IR ACs in particular,
// publish fan_modes in DESCENDING speed order (e.g. ["high", "mid", "low"]).
// HAMH maps the Matter percentage onto the list by position, assuming ascending
// speed, so a descending list inverts the slider (100% picks the slowest). This
// helper normalizes a recognized speed-keyword list into ascending order so the
// mapping is correct regardless of how the integration ordered the modes (#309).

const SPEED_RANK: Record<string, number> = {
  quiet: 0,
  silent: 0,
  sleep: 0,
  eco: 0,
  mute: 0,
  min: 0,
  minimum: 0,
  low: 1,
  lo: 1,
  slow: 1,
  weak: 1,
  light: 1,
  mediumlow: 2,
  midlow: 2,
  medium: 3,
  mid: 3,
  med: 3,
  normal: 3,
  moderate: 3,
  standard: 3,
  mediumhigh: 4,
  midhigh: 4,
  high: 5,
  hi: 5,
  fast: 5,
  strong: 6,
  powerful: 6,
  power: 6,
  focus: 6,
  turbo: 7,
  max: 7,
  maximum: 7,
  boost: 7,
  jet: 7,
};

function rankOf(token: string): number | undefined {
  const key = token.toLowerCase().replace(/[ _-]/g, "");
  if (key in SPEED_RANK) {
    return SPEED_RANK[key];
  }
  const level = key.match(/^level(\d+)$/);
  if (level) {
    return Number(level[1]);
  }
  if (/^\d+$/.test(key)) {
    return Number(key);
  }
  return undefined;
}

/**
 * Reorder a speed-preset list into ascending speed. Only reorders when EVERY
 * token is a recognized speed keyword (or a numeric / levelN value); otherwise
 * the list is returned unchanged, so already-ascending and vendor-specific lists
 * are never mangled. The "auto" preset must be filtered out by the caller.
 */
export function toAscendingSpeedPresets(presets: string[]): string[] {
  const ranks = presets.map(rankOf);
  if (ranks.some((rank) => rank === undefined)) {
    return presets.slice();
  }
  return presets
    .map((value, index) => ({ value, index, rank: ranks[index] as number }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.value);
}

/**
 * Map a Matter rotation-speed percentage to a preset index. The read direction
 * reports preset i as (i+1)/count * 100, so each preset's percentage is the
 * upper edge of its band and a boundary value belongs to the lower preset
 * (25% with four presets is the first, not the second). Same ceil-1 rule as
 * FanMode.fromSpeedPercent (#369).
 */
export function percentToPresetIndex(
  percentage: number,
  count: number,
): number {
  if (count <= 0) {
    return 0;
  }
  const index = Math.ceil((percentage / 100) * count) - 1;
  return Math.max(0, Math.min(count - 1, index));
}
