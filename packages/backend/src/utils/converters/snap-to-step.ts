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
 * Without a valid step the target is rounded to 0.1, which drops the float
 * noise of the centi-degree conversion (2111 -> 69.998 F) that HA stores as is.
 */
export function snapToStep(
  target: number,
  current: number | undefined,
  step: number | undefined,
): number {
  if (step == null || !Number.isFinite(step) || step <= 0) {
    return Math.round(target * 10) / 10;
  }
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
