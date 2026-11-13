// Home Assistant reports these in place of a real state or option.
export function isSentinelState(value: string | null | undefined): boolean {
  const s = value?.toLowerCase();
  return s === "unavailable" || s === "unknown";
}
