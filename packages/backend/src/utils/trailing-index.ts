/**
 * Returns the trailing integer of a string, or `undefined` when it does not
 * end in digits.
 *
 * Used to pair per-outlet entities of a multi-outlet device by their index,
 * e.g. `switch.strip_switch_2` -> 2 and `sensor.strip_power_2` -> 2.
 */
export function trailingIndex(value: string): number | undefined {
  const match = /(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : undefined;
}
