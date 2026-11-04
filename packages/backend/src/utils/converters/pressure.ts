/**
 * Convert a pressure value from the given unit to hPa (hectoPascals).
 * Matter PressureMeasurement expects values in kPa * 10 (decikiloPascals),
 * which is numerically equal to hPa.
 *
 * @param pressure - The raw pressure value
 * @param unit - The unit of measurement (e.g. "hPa", "mbar", "kPa", "Pa", "bar", "cbar", "psi", "inHg", "mmHg")
 * @returns The pressure in hPa, or undefined if conversion is not possible
 */
export function convertPressureToHpa(
  pressure: number,
  unit: string | undefined,
): number | undefined {
  const normalizedUnit = unit?.toLowerCase();
  if (normalizedUnit === "pa") {
    return pressure / 100;
  }
  if (normalizedUnit === "kpa") {
    return pressure * 10;
  }
  if (normalizedUnit === "mbar" || normalizedUnit === "hpa") {
    return pressure;
  }
  if (normalizedUnit === "bar") {
    return pressure * 1000;
  }
  if (normalizedUnit === "cbar") {
    return pressure * 10;
  }
  if (normalizedUnit === "psi") {
    return pressure * 68.9476;
  }
  if (normalizedUnit === "inhg") {
    return pressure * 33.8639;
  }
  if (normalizedUnit === "mmhg") {
    return pressure * 1.33322;
  }
  // Assume hPa by default
  return pressure;
}
