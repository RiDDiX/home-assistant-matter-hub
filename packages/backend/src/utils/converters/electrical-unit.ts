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
    ["GW", 1_000_000_000_000],
    ["TW", 1_000_000_000_000_000],
    ["BTU/h", 293.07107],
  ]),
  voltage: new Map([
    ["μV", 0.001],
    ["µV", 0.001],
    ["mV", 1],
    ["V", 1_000],
    ["kV", 1_000_000],
    ["MV", 1_000_000_000],
  ]),
  current: new Map([
    ["mA", 1],
    ["A", 1_000],
  ]),
  // 1 Wh = 3600 J, 1 cal = 4.184 J
  energy: new Map([
    ["J", 1_000 / 3_600],
    ["kJ", 1_000_000 / 3_600],
    ["MJ", 1_000_000_000 / 3_600],
    ["GJ", 1_000_000_000_000 / 3_600],
    ["mWh", 1],
    ["Wh", 1_000],
    ["kWh", 1_000_000],
    ["MWh", 1_000_000_000],
    ["GWh", 1_000_000_000_000],
    ["TWh", 1_000_000_000_000_000],
    ["cal", 4_184 / 3_600],
    ["kcal", 4_184_000 / 3_600],
    ["Mcal", 4_184_000_000 / 3_600],
    ["Gcal", 4_184_000_000_000 / 3_600],
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
