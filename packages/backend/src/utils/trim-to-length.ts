// Matter string limits count UTF-8 bytes, so CJK names must be cut by bytes (#518)
export function trimToLength(
  value: string | number | null | undefined,
  maxLength: number,
  suffix: string,
): string | undefined {
  const stringValue = value?.toString();
  if (!stringValue?.trim().length) {
    return undefined;
  }
  if (Buffer.byteLength(stringValue) <= maxLength) {
    return stringValue;
  }
  const suffixLength = Buffer.byteLength(suffix);
  if (suffixLength > maxLength) {
    return cutToBytes(stringValue, maxLength);
  }
  return cutToBytes(stringValue, maxLength - suffixLength) + suffix;
}

// Longest prefix within maxBytes UTF-8 bytes, never splitting a code point.
export function cutToBytes(value: string, maxBytes: number): string {
  let room = maxBytes;
  let trimmed = "";
  for (const char of value) {
    room -= Buffer.byteLength(char);
    if (room < 0) break;
    trimmed += char;
  }
  return trimmed;
}
