/**
 * Trailing integer for outlet pairing (`switch.strip_switch_2` -> 2).
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

// Index from where the two ids start to differ. On a device named "Power
// Strip 4" a plain trailing index reads outlet 1 as outlet 4 (#488).
export function pairingIndex(
  entityId: string,
  otherId: string,
): number | undefined {
  const a = withoutDomain(entityId);
  const b = withoutDomain(otherId);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // stopped inside a number (_101 vs _11), back out to its first digit
  if (isDigit(a[i]) && isDigit(b[i])) {
    while (i > 0 && isDigit(a[i - 1])) i--;
  }
  return trailingIndex(a.slice(i));
}
