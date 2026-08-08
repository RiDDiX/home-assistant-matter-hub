/**
 * Snap a target temperature to the nearest multiple of `step`.
 *
 * Ties (target exactly between two step boundaries) break away from
 * `current`: a controller nudging up by half a step lands on the next
 * step up, nudging down lands on the next step down. This matches what
 * users expect from Apple Home / Google Home when the underlying HA
 * entity only supports integer steps but the controller sends 0.5°C
 * deltas.
 *
 * Pass-through when step is missing/invalid.
 */
export function snapToStep(
  target: number,
  current: number | undefined,
  step: number | undefined,
): number {
  if (step == null || !Number.isFinite(step) || step <= 0) return target;
  const ratio = target / step;
  const lower = Math.floor(ratio) * step;
  const upper = Math.ceil(ratio) * step;
  if (lower === upper) return target;
  const distLower = target - lower;
  const distUpper = upper - target;
  if (distLower < distUpper) return lower;
  if (distUpper < distLower) return upper;
  if (current == null || !Number.isFinite(current)) return upper;
  return target > current ? upper : lower;
}
