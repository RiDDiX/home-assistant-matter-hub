/**
 * Returns the trailing integer of a string, or `undefined` when it does not
 * end in digits.
 *
 * Used to pair per-outlet entities of a multi-outlet device by their index,
 * e.g. `switch.strip_2` -> 2 and `sensor.strip_power_2` -> 2.
 */
export function trailingIndex(value: string): number | undefined {
  const match = /(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function isDigit(char: string | undefined): boolean {
  return char != null && char >= "0" && char <= "9";
}

function withoutDomain(entityId: string): string {
  return entityId.slice(entityId.indexOf(".") + 1);
}

/**
 * The outlet index of `entityId` relative to `otherId`, taken from the part
 * where the two ids start to differ.
 *
 * A plain trailing index cannot tell an outlet number from a number in the
 * device's own name. The reporter's device in #488 is a "Shelly Power Strip 4",
 * so the first outlet is `switch.kitchen_shelly_power_strip_4` and a trailing
 * index reads that as outlet 4 and hands it the fourth outlet's sensor. Both
 * ids share the device name, so comparing only the part after the shared
 * prefix leaves the digits that actually distinguish the outlets.
 */
export function pairingIndex(
  entityId: string,
  otherId: string,
): number | undefined {
  const a = withoutDomain(entityId);
  const b = withoutDomain(otherId);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // Two indices sharing a leading digit stop the walk inside a number, and
  // `_101` and `_11` would both come out as 1. Back out to where that number
  // starts. A walk that simply ran off the end of one id is not in that case,
  // so the digits of a shared device name stay part of the prefix.
  if (isDigit(a[i]) && isDigit(b[i])) {
    while (i > 0 && isDigit(a[i - 1])) i--;
  }
  return trailingIndex(a.slice(i));
}
