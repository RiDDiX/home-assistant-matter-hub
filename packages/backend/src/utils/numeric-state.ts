// +"" and +" " are 0, so a blank state would read as a real zero.
export function numericState(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = +value;
  return Number.isFinite(n) ? n : null;
}
