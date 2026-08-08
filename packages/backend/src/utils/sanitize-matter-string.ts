/**
 * Strip characters known to crash certain Matter controllers (e.g. Aqara).
 * Removes *, !, ~, and control characters. Preserves unicode letters, digits,
 * spaces, hyphens, parentheses, and other common punctuation.
 */
export function sanitizeMatterString(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
  return value.replace(/[*!~\x00-\x1f\x7f]/g, "").trim();
}
