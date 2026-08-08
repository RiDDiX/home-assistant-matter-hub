// Infer which custom service area a batch vacuum is cleaning from a cumulative
// cleaned-area value plus the per-room sizes. Such vacuums report total m2 but
// not the current room, so currentArea is otherwise stuck on the first one
// (#368). Display-only: the caller maps the result onto currentArea + progress,
// never a cleaning command.

export interface InferCleanedAreaResult {
  /** Area being cleaned now, or null once the cleaned area covers every room. */
  currentArea: number | null;
  /** Areas whose full size has been cleaned. */
  completed: number[];
}

/**
 * Map a cumulative cleaned area onto the active selection (in clean order).
 * The current room is the first whose cumulative end exceeds the cleaned area;
 * every room before it is completed. A room is completed once its end is
 * reached exactly (strict less-than), so a 0 m2 room is skipped instantly.
 */
export function inferCleanedAreaProgress(
  cleanedSqm: number,
  orderedAreas: { areaId: number; sizeSqm: number }[],
): InferCleanedAreaResult {
  if (orderedAreas.length === 0) {
    return { currentArea: null, completed: [] };
  }
  const cleaned = Number.isFinite(cleanedSqm) ? Math.max(0, cleanedSqm) : 0;
  let cumulative = 0;
  const completed: number[] = [];
  for (const area of orderedAreas) {
    const size = Number.isFinite(area.sizeSqm) ? Math.max(0, area.sizeSqm) : 0;
    cumulative += size;
    if (cleaned < cumulative) {
      return { currentArea: area.areaId, completed };
    }
    completed.push(area.areaId);
  }
  return { currentArea: null, completed };
}
