import { cutToBytes } from "./trim-to-length.js";

// Matter caps the serial number at 32 UTF-8 bytes. The raw serial gets what
// the suffix leaves, so the suffix survives the cap (#330).
export function serialNumberWithSuffix(
  suffix: string | undefined,
  rawSerial: (maxLength: number) => string | undefined,
): string | undefined {
  const fitted = suffix && cutToBytes(suffix, 32);
  const raw = rawSerial(32 - Buffer.byteLength(fitted ?? ""));
  return raw != null && fitted ? `${raw}${fitted}` : raw;
}
