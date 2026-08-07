import {
  type WaterHeaterDeviceAttributes,
  WaterHeaterOperationMode,
} from "@home-assistant-matter-hub/common";
import {
  type WaterHeaterManagement,
  WaterHeaterMode,
} from "@matter/main/clusters";

/**
 * Matter mode values for the Home Assistant operation modes we know about.
 *
 * These are wire values a controller caches after commissioning, so they are
 * fixed per HA operation mode and must never be renumbered. Modes reported by
 * an integration that are not in this list get ids from UNKNOWN_MODE_BASE
 * upwards, in operation_list order.
 */
const KNOWN_MODE_VALUES: Record<string, number> = {
  [WaterHeaterOperationMode.off]: 0,
  [WaterHeaterOperationMode.eco]: 1,
  [WaterHeaterOperationMode.electric]: 2,
  [WaterHeaterOperationMode.gas]: 3,
  [WaterHeaterOperationMode.heat_pump]: 4,
  [WaterHeaterOperationMode.high_demand]: 5,
  [WaterHeaterOperationMode.performance]: 6,
};

/** The Off mode is always present, whether or not HA lists an "off" mode. */
export const OFF_MODE = 0;

/**
 * Mode used when the entity exposes no operation modes at all. The Matter
 * WaterHeaterMode cluster still requires a Manual-tagged mode, so we synthesize
 * one that maps onto water_heater.turn_on.
 */
const SYNTHETIC_MANUAL_MODE = 7;

const UNKNOWN_MODE_BASE = 8;

/**
 * Which HA operation mode gets the Manual tag, in order of preference. Manual
 * means "heat to the thermostat setpoint", so a plain heat-source mode is a
 * better fit than eco or a boost mode. Exactly one mode may carry this tag.
 */
const MANUAL_PREFERENCE: string[] = [
  WaterHeaterOperationMode.heat_pump,
  WaterHeaterOperationMode.electric,
  WaterHeaterOperationMode.gas,
  WaterHeaterOperationMode.eco,
  WaterHeaterOperationMode.performance,
  WaterHeaterOperationMode.high_demand,
];

/**
 * Tags for the modes that do not carry Manual or Off. Off, Manual and Timed
 * must each appear at most once and alone, the remaining tags are unrestricted.
 */
const MODE_TAGS: Record<string, WaterHeaterMode.ModeTag> = {
  [WaterHeaterOperationMode.eco]: WaterHeaterMode.ModeTag.LowEnergy,
  [WaterHeaterOperationMode.high_demand]: WaterHeaterMode.ModeTag.Max,
  [WaterHeaterOperationMode.performance]: WaterHeaterMode.ModeTag.Quick,
  [WaterHeaterOperationMode.heat_pump]: WaterHeaterMode.ModeTag.LowEnergy,
  [WaterHeaterOperationMode.electric]: WaterHeaterMode.ModeTag.Auto,
  [WaterHeaterOperationMode.gas]: WaterHeaterMode.ModeTag.Auto,
};

/** Heat source each HA operation mode calls on, where it is identifiable. */
const HEAT_SOURCES: Record<
  string,
  keyof WaterHeaterManagement.WaterHeaterHeatSource
> = {
  [WaterHeaterOperationMode.electric]: "immersionElement1",
  [WaterHeaterOperationMode.gas]: "boiler",
  [WaterHeaterOperationMode.heat_pump]: "heatPump",
};

/**
 * The HA operation mode a Boost command switches to, in order of preference.
 * Both mean "heat as fast as you can" in Home Assistant terms.
 */
const BOOST_PREFERENCE: string[] = [
  WaterHeaterOperationMode.high_demand,
  WaterHeaterOperationMode.performance,
];

export interface WaterHeaterModeMapping {
  readonly supportedModes: WaterHeaterMode.ModeOption[];
  /**
   * Matter mode value to HA operation mode. A null value means the mode has no
   * HA operation mode behind it and is driven through water_heater.turn_on /
   * water_heater.turn_off instead.
   */
  readonly haOperationModes: Readonly<Record<number, string | null>>;
  /** Mode value carrying the Manual tag. */
  readonly manualMode: number;
  /** HA operation mode a Boost switches to, undefined when none is offered. */
  readonly boostOperationMode?: string;
}

function humanize(operationMode: string): string {
  const label = operationMode
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  // ModeOptionStruct.Label is capped at 64 characters by the spec.
  return label.slice(0, 64);
}

/**
 * Build the WaterHeaterMode supported modes from an entity's operation_list.
 *
 * The cluster server asserts its invariants during initialize(), before any HA
 * state arrives, so the result has to be seeded onto the behavior at endpoint
 * construction time rather than patched in later.
 */
export function buildModeMapping(
  attributes: WaterHeaterDeviceAttributes,
): WaterHeaterModeMapping {
  const operationList = (attributes.operation_list ?? []).filter(
    (mode): mode is string => typeof mode === "string" && mode.length > 0,
  );
  const heatingModes = operationList.filter(
    (mode) => mode !== WaterHeaterOperationMode.off,
  );

  const haOperationModes: Record<number, string | null> = {
    // Off is synthesized when HA does not list it, and then falls back to
    // water_heater.turn_off.
    [OFF_MODE]: operationList.includes(WaterHeaterOperationMode.off)
      ? WaterHeaterOperationMode.off
      : null,
  };

  const supportedModes: WaterHeaterMode.ModeOption[] = [
    {
      label: "Off",
      mode: OFF_MODE,
      modeTags: [{ value: WaterHeaterMode.ModeTag.Off }],
    },
  ];

  const manualOperationMode = MANUAL_PREFERENCE.find((mode) =>
    heatingModes.includes(mode),
  );
  const manualMode =
    manualOperationMode != null
      ? KNOWN_MODE_VALUES[manualOperationMode]
      : SYNTHETIC_MANUAL_MODE;

  if (manualOperationMode == null) {
    // No operation modes at all (or off-only): a Manual mode is still
    // mandatory, so drive it through water_heater.turn_on.
    supportedModes.push({
      label: "On",
      mode: SYNTHETIC_MANUAL_MODE,
      modeTags: [{ value: WaterHeaterMode.ModeTag.Manual }],
    });
    haOperationModes[SYNTHETIC_MANUAL_MODE] = null;
  }

  let nextUnknownMode = UNKNOWN_MODE_BASE;
  for (const operationMode of heatingModes) {
    const mode = KNOWN_MODE_VALUES[operationMode] ?? nextUnknownMode++;
    if (haOperationModes[mode] !== undefined) {
      // Duplicate entry in operation_list, keep the first.
      continue;
    }
    haOperationModes[mode] = operationMode;
    supportedModes.push({
      label: humanize(operationMode),
      mode,
      modeTags: [
        {
          value:
            operationMode === manualOperationMode
              ? WaterHeaterMode.ModeTag.Manual
              : (MODE_TAGS[operationMode] ?? WaterHeaterMode.ModeTag.Auto),
        },
      ],
    });
  }

  return {
    supportedModes,
    haOperationModes,
    manualMode,
    boostOperationMode: BOOST_PREFERENCE.find((mode) =>
      heatingModes.includes(mode),
    ),
  };
}

/** Matter mode value currently reported by the entity. */
export function currentMode(
  mapping: WaterHeaterModeMapping,
  entityState: string,
  attributes: WaterHeaterDeviceAttributes,
): number {
  if (entityState === WaterHeaterOperationMode.off) {
    return OFF_MODE;
  }
  const operationMode = attributes.operation_mode;
  if (operationMode === WaterHeaterOperationMode.off) {
    return OFF_MODE;
  }
  if (operationMode != null) {
    for (const [mode, haMode] of Object.entries(mapping.haOperationModes)) {
      if (haMode === operationMode) {
        return Number(mode);
      }
    }
  }
  return mapping.manualMode;
}

/** Heat sources the appliance can call on, derived from its operation modes. */
export function heaterTypes(
  attributes: WaterHeaterDeviceAttributes,
): WaterHeaterManagement.WaterHeaterHeatSource {
  const sources: WaterHeaterManagement.WaterHeaterHeatSource = {};
  for (const operationMode of attributes.operation_list ?? []) {
    const source = operationMode != null ? HEAT_SOURCES[operationMode] : null;
    if (source) {
      sources[source] = true;
    }
  }
  if (Object.keys(sources).length === 0) {
    // HA never says how the water is heated for eco/performance-only heaters.
    sources.other = true;
  }
  return sources;
}

/** Heat source behind the operation mode the entity is currently in. */
export function activeHeatSource(
  attributes: WaterHeaterDeviceAttributes,
): WaterHeaterManagement.WaterHeaterHeatSource {
  const operationMode = attributes.operation_mode;
  const source = operationMode != null ? HEAT_SOURCES[operationMode] : null;
  if (source) {
    return { [source]: true };
  }
  return heaterTypes(attributes);
}
