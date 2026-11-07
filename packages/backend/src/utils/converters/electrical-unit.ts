import type {
  HomeAssistantEntityState,
  SensorDeviceAttributes,
} from "@home-assistant-matter-hub/common";

export type ElectricalQuantity = "power" | "voltage" | "current" | "energy";

// Factor from a Home Assistant unit to the milli unit Matter reports (mW, mV,
// mA, mWh). Case sensitive on purpose, mW and MW are nine orders apart.
const MILLI_FACTORS: Record<ElectricalQuantity, Map<string, number>> = {
  power: new Map([
    ["mW", 1],
    ["W", 1_000],
    ["kW", 1_000_000],
    ["MW", 1_000_000_000],
  ]),
  voltage: new Map([
    ["mV", 1],
    ["V", 1_000],
    ["kV", 1_000_000],
  ]),
  current: new Map([
    ["mA", 1],
    ["A", 1_000],
  ]),
  energy: new Map([
    ["Wh", 1_000],
    ["kWh", 1_000_000],
    ["MWh", 1_000_000_000],
  ]),
};

// A missing or unknown unit keeps the documented mapping contract.
const DEFAULT_UNIT: Record<ElectricalQuantity, string> = {
  power: "W",
  voltage: "V",
  current: "A",
  energy: "kWh",
};

export function toMatterMilli(
  value: number,
  quantity: ElectricalQuantity,
  unit: string | undefined,
): number {
  const factors = MILLI_FACTORS[quantity];
  const factor =
    (unit != null ? factors.get(unit) : undefined) ??
    (factors.get(DEFAULT_UNIT[quantity]) as number);
  return Math.round(value * factor);
}

interface StateSource {
  getState(entityId: string): HomeAssistantEntityState | undefined;
  getNumericState(entityId: string): number | null;
}

// A mapped companion sensor's reading in Matter milli units, null when it has
// no numeric state.
export function mappedMilli(
  source: StateSource,
  entityId: string,
  quantity: ElectricalQuantity,
): number | null {
  const value = source.getNumericState(entityId);
  if (value == null) return null;
  const attrs = source.getState(entityId)?.attributes as
    | SensorDeviceAttributes
    | undefined;
  return toMatterMilli(value, quantity, attrs?.unit_of_measurement);
}
