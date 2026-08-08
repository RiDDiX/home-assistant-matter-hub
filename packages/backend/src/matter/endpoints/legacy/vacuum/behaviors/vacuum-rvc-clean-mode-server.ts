import type { VacuumDeviceAttributes } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import { RvcCleanMode } from "@matter/main/clusters";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  RvcCleanModeServer,
  type RvcCleanModeServerInitialState,
} from "../../../../behaviors/rvc-clean-mode-server.js";
import {
  isDreameVacuum,
  isEcovacsVacuum,
} from "../utils/parse-vacuum-rooms.js";

const logger = Logger.get("VacuumRvcCleanModeServer");

// ---------------------------------------------------------------------------
// Mode IDs, flat structure matching the pattern Apple Home expects.
// Cleaning-type modes and fan-speed modes are siblings, NOT cross-products.
// Apple Home groups modes by their tags:
//   • Cleaning types (Vacuum / Mop / Vacuum+Mop / VacuumThenMop) appear
//     in the main mode selector.
//   • Fan-speed modes that share the Vacuum tag but add Quiet / Max
//     appear in the "extra features" panel.
// ---------------------------------------------------------------------------

const MODE_VACUUM = 0;
const MODE_VACUUM_AND_MOP = 1;
const MODE_MOP = 2;
const MODE_VACUUM_THEN_MOP = 3;

/** Base mode value for dynamically generated fan speed modes */
const FAN_SPEED_MODE_BASE = 10;

/** Base mode value for dynamically generated mop intensity modes */
const MOP_INTENSITY_MODE_BASE = 50;

/** Check if a mode value represents a fan speed mode */
function isFanSpeedMode(mode: number): boolean {
  return mode >= FAN_SPEED_MODE_BASE && mode < MOP_INTENSITY_MODE_BASE;
}

/** Check if a mode value represents a mop intensity mode */
function isMopIntensityMode(mode: number): boolean {
  return mode >= MOP_INTENSITY_MODE_BASE;
}

export enum CleanType {
  Sweeping = 0,
  Mopping = 1,
  SweepingAndMopping = 2,
  MoppingAfterSweeping = 3,
}

// ---------------------------------------------------------------------------
// Supported mode lists
// ---------------------------------------------------------------------------

function resolveCleanTypes(cleaningModeOptions?: string[]): Set<CleanType> {
  if (!cleaningModeOptions || cleaningModeOptions.length === 0) {
    return new Set();
  }
  const types = new Set<CleanType>();
  for (const option of cleaningModeOptions) {
    types.add(parseCleanType(option));
  }
  return types;
}

export function buildSupportedModes(
  fanSpeedList?: string[],
  mopIntensityList?: string[],
  cleaningModeOptions?: string[],
  customFanSpeedTags?: Record<string, number>,
): RvcCleanMode.ModeOption[] {
  const cleanTypes = resolveCleanTypes(cleaningModeOptions);
  const modes: RvcCleanMode.ModeOption[] = [
    {
      label: "Vacuum",
      mode: MODE_VACUUM,
      modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }],
    },
  ];

  if (cleanTypes.has(CleanType.SweepingAndMopping)) {
    modes.push({
      label: "Vacuum & Mop",
      mode: MODE_VACUUM_AND_MOP,
      modeTags: [
        { value: RvcCleanMode.ModeTag.Vacuum },
        { value: RvcCleanMode.ModeTag.Mop },
      ],
    });
  }

  if (cleanTypes.has(CleanType.Mopping)) {
    modes.push({
      label: "Mop",
      mode: MODE_MOP,
      modeTags: [{ value: RvcCleanMode.ModeTag.Mop }],
    });
  }

  // Fan-speed modes are generated dynamically from fan_speed_list.
  // Apple Home shows them as "extra features" when the Vacuum cleaning
  // type is active (they share the Vacuum tag with an intensity tag).
  if (fanSpeedList && fanSpeedList.length > 0) {
    modes.push(...buildFanSpeedModes(fanSpeedList, customFanSpeedTags));
  }

  // Mop-intensity modes: included when any mopping mode is available
  const hasMopping =
    cleanTypes.has(CleanType.Mopping) ||
    cleanTypes.has(CleanType.SweepingAndMopping);
  if (hasMopping && mopIntensityList && mopIntensityList.length > 0) {
    modes.push(...buildMopIntensityModes(mopIntensityList));
  }

  // VacuumThenMop only when the entity actually supports it
  if (cleanTypes.has(CleanType.MoppingAfterSweeping)) {
    modes.push({
      label: "Vacuum Then Mop",
      mode: MODE_VACUUM_THEN_MOP,
      modeTags: [
        { value: RvcCleanMode.ModeTag.DeepClean },
        { value: RvcCleanMode.ModeTag.Vacuum },
        { value: RvcCleanMode.ModeTag.Mop },
      ],
    });
  }

  return modes;
}

// Cleaning mode tokens. Classify any vendor phrasing by the words it
// contains instead of maintaining per-vendor alias lists.
const CLEAN_TOKENS = {
  vacuum: /\b(vacuum|vacuuming|sweep|sweeping|suction)\b/i,
  mop: /\b(mop|mopping|wipe|wet|wash|scrub)\b/i,
  sequential:
    /\b(then|after|before|followed|following|first|secondly|sequentially)\b/i,
} as const;

function normalizeCleanLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-+&/. ]+/g, " ")
    .replace(/\band\b/g, " ")
    .trim();
}

function classifyCleanOption(option: string): CleanType {
  const s = normalizeCleanLabel(option);
  const hasVac = CLEAN_TOKENS.vacuum.test(s);
  const hasMop = CLEAN_TOKENS.mop.test(s);
  const hasSeq = CLEAN_TOKENS.sequential.test(s);
  if (hasVac && hasMop && hasSeq) return CleanType.MoppingAfterSweeping;
  if (hasVac && hasMop) return CleanType.SweepingAndMopping;
  if (hasMop) return CleanType.Mopping;
  return CleanType.Sweeping;
}

const CLEAN_TYPE_LABELS: Record<CleanType, string> = {
  [CleanType.Sweeping]: "Sweeping",
  [CleanType.Mopping]: "Mopping",
  [CleanType.SweepingAndMopping]: "Sweeping and mopping",
  [CleanType.MoppingAfterSweeping]: "Mopping after sweeping",
};

// ---------------------------------------------------------------------------
// Fan speed tag patterns (regex-based, manufacturer-agnostic)
// ---------------------------------------------------------------------------
// Each pattern matches the FULL fan_speed_list entry (anchored with ^ $).
// Compound names like "max_plus" do NOT match any pattern.
// Apple Home hides modes without a recognized intensity tag,
// so unmatched speeds will not be selectable from the Apple Home UI.

const FAN_TAG_PATTERNS: Array<{ pattern: RegExp; tag: number }> = [
  {
    pattern: /^(quiet|silent|low|eco|gentle|min|leise)$/i,
    tag: RvcCleanMode.ModeTag.Quiet,
  },
  {
    // Apple Home renders the Auto tag as "Automatic".
    // Mid-range names like "normal", "standard", "balanced" map here
    // because untagged modes are hidden in Apple Home entirely.
    // "Automatic" is imperfect but the only way to make them visible.
    pattern: /^(auto|normal|standard|balanced|medium|default|regular|mittel)$/i,
    tag: RvcCleanMode.ModeTag.Auto,
  },
  {
    pattern: /^(turbo|max|strong|boost|power|high|full|stark|max_plus|max\+)$/i,
    tag: RvcCleanMode.ModeTag.Max,
  },
];

function getFanSpeedTag(
  name: string,
  customTags?: Record<string, number>,
): number | undefined {
  if (customTags && customTags[name] !== undefined) {
    return customTags[name];
  }

  const s = name.toLowerCase().trim();
  for (const { pattern, tag } of FAN_TAG_PATTERNS) {
    if (pattern.test(s)) return tag;
  }
  return undefined;
}

function formatFanSpeedLabel(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildFanSpeedModes(
  fanSpeedList: string[],
  customTags?: Record<string, number>,
): RvcCleanMode.ModeOption[] {
  // Assign intensity tags to ALL matching speeds so Apple Home
  // shows every recognized speed. Multiple speeds can share the
  // same tag, Apple Home distinguishes them by label.
  return fanSpeedList.map((name, index) => {
    const tag = getFanSpeedTag(name, customTags);
    const modeTags: { value: number }[] = [
      { value: RvcCleanMode.ModeTag.Vacuum },
    ];
    if (tag !== undefined) {
      modeTags.push({ value: tag });
    }
    return {
      label: formatFanSpeedLabel(name),
      mode: FAN_SPEED_MODE_BASE + index,
      modeTags,
    };
  });
}

// ---------------------------------------------------------------------------
// Mop intensity tag patterns (regex-based, manufacturer-agnostic)
// ---------------------------------------------------------------------------
// Covers Dreame (low/medium/high), Ecovacs (low/medium/high/very_high),
// and other naming conventions for mop pad humidity / water level.

const MOP_TAG_PATTERNS: Array<{ pattern: RegExp; tag: number }> = [
  {
    pattern:
      /^(low|light|gentle|mild|min|slightly_wet|slightly_dry|dry|leicht)$/i,
    tag: RvcCleanMode.ModeTag.Quiet,
  },
  {
    // Apple Home renders the Auto tag as "Automatic".
    // Mid-range names like "medium", "moderate" map here
    // because untagged modes are hidden in Apple Home entirely.
    pattern: /^(auto|medium|moderate|normal|standard|mittel)$/i,
    tag: RvcCleanMode.ModeTag.Auto,
  },
  {
    pattern: /^(high|intense|strong|max|very_wet|wet|heavy|hoch|stark)$/i,
    tag: RvcCleanMode.ModeTag.Max,
  },
  {
    pattern: /^(deep_clean|deep|ultra|very_high)$/i,
    tag: RvcCleanMode.ModeTag.DeepClean,
  },
];

function getMopIntensityTag(name: string): number | undefined {
  const s = name.toLowerCase().trim();
  for (const { pattern, tag } of MOP_TAG_PATTERNS) {
    if (pattern.test(s)) return tag;
  }
  return undefined;
}

function buildMopIntensityModes(
  mopIntensityList: string[],
): RvcCleanMode.ModeOption[] {
  // Assign intensity tags to ALL matching mop intensities so
  // Apple Home shows every recognized option by label.
  return mopIntensityList.map((name, index) => {
    const tag = getMopIntensityTag(name);
    const modeTags: { value: number }[] = [{ value: RvcCleanMode.ModeTag.Mop }];
    if (tag !== undefined) {
      modeTags.push({ value: tag });
    }
    return {
      label: `Mop ${formatFanSpeedLabel(name)}`,
      mode: MOP_INTENSITY_MODE_BASE + index,
      modeTags,
    };
  });
}

function mopIntensityToModeId(
  intensity: string | undefined,
  mopIntensityList: string[],
): number | undefined {
  if (!intensity) return undefined;
  const s = intensity.toLowerCase();
  const exactIndex = mopIntensityList.findIndex((f) => f.toLowerCase() === s);
  if (exactIndex >= 0) return MOP_INTENSITY_MODE_BASE + exactIndex;
  const containsIndex = mopIntensityList.findIndex(
    (f) => s.includes(f.toLowerCase()) || f.toLowerCase().includes(s),
  );
  if (containsIndex >= 0) return MOP_INTENSITY_MODE_BASE + containsIndex;
  return undefined;
}

function matchMopIntensityOption(
  name: string,
  availableOptions: string[] | undefined,
): string | undefined {
  if (!availableOptions || availableOptions.length === 0) return undefined;
  const s = name.toLowerCase();
  const exact = availableOptions.find((o) => o.toLowerCase() === s);
  if (exact) return exact;
  const contains = availableOptions.find(
    (o) => o.toLowerCase().includes(s) || s.includes(o.toLowerCase()),
  );
  if (contains) return contains;
  const tag = getMopIntensityTag(name);
  if (tag !== undefined) {
    const group = MOP_TAG_PATTERNS.find((p) => p.tag === tag);
    if (group) {
      const aliases = group.pattern.source
        .replace(/^\^\(|\)\$$/g, "")
        .split("|");
      for (const a of aliases) {
        const m = availableOptions.find(
          (o) => o.toLowerCase() === a || o.toLowerCase().includes(a),
        );
        if (m) return m;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseCleanType(modeString: string | undefined): CleanType {
  if (!modeString) return CleanType.Sweeping;
  return classifyCleanOption(modeString);
}

function cleanTypeToModeId(ct: CleanType): number {
  switch (ct) {
    case CleanType.Sweeping:
      return MODE_VACUUM;
    case CleanType.Mopping:
      return MODE_MOP;
    case CleanType.SweepingAndMopping:
      return MODE_VACUUM_AND_MOP;
    case CleanType.MoppingAfterSweeping:
      return MODE_VACUUM_THEN_MOP;
  }
}

function modeIdToCleanType(mode: number): CleanType {
  switch (mode) {
    case MODE_MOP:
      return CleanType.Mopping;
    case MODE_VACUUM_AND_MOP:
      return CleanType.SweepingAndMopping;
    case MODE_VACUUM_THEN_MOP:
      return CleanType.MoppingAfterSweeping;
    default:
      return CleanType.Sweeping;
  }
}

function fanSpeedToModeId(
  speed: string | undefined,
  fanSpeedList: string[],
): number | undefined {
  if (!speed) return undefined;
  const s = speed.toLowerCase();
  // Exact match
  const exactIndex = fanSpeedList.findIndex((f) => f.toLowerCase() === s);
  if (exactIndex >= 0) return FAN_SPEED_MODE_BASE + exactIndex;
  // Contains match
  const containsIndex = fanSpeedList.findIndex(
    (f) => s.includes(f.toLowerCase()) || f.toLowerCase().includes(s),
  );
  if (containsIndex >= 0) return FAN_SPEED_MODE_BASE + containsIndex;
  return undefined;
}

// Fallback: when no direct match, try semantically similar clean types.
// "Vacuum Then Mop" falls back to "Vacuum & Mop" when the entity
// doesn't expose a dedicated option (e.g. Roborock template selects).
const CLEAN_TYPE_FALLBACK: Partial<Record<CleanType, CleanType>> = {
  [CleanType.MoppingAfterSweeping]: CleanType.SweepingAndMopping,
};

function findMatchingCleanOption(
  ct: CleanType,
  availableOptions: string[] | undefined,
): string {
  if (!availableOptions || availableOptions.length === 0) {
    return CLEAN_TYPE_LABELS[ct];
  }

  const typesToTry: CleanType[] = [ct];
  const fallback = CLEAN_TYPE_FALLBACK[ct];
  if (fallback !== undefined) typesToTry.push(fallback);

  for (const type of typesToTry) {
    const match = availableOptions.find((o) => classifyCleanOption(o) === type);
    if (match) return match;
  }

  logger.warn(
    `No match for ${CLEAN_TYPE_LABELS[ct]} in [${availableOptions.join(", ")}]`,
  );
  return availableOptions[0];
}

/**
 * Build a cleaning mode action for the target type.
 * Always returns an action, the debounce layer ensures rapid switches
 * resolve to the last requested type.
 */
function buildCleaningModeAction(
  targetCleanType: CleanType,
  agent: Agent,
): { action: string; data: { option: string }; target: string } {
  const selectEntityId = getCleaningModeSelectEntity(agent);
  const { options } = readSelectEntity(selectEntityId, agent);
  const optionToUse = findMatchingCleanOption(targetCleanType, options);
  logger.info(
    `Switching cleaning mode to: ${optionToUse} via ${selectEntityId}`,
  );
  return {
    action: "select.select_option",
    data: { option: optionToUse },
    target: selectEntityId,
  };
}

function matchFanSpeedOption(
  name: string,
  availableOptions: string[] | undefined,
  customTags?: Record<string, number>,
): string | undefined {
  if (!availableOptions || availableOptions.length === 0) return undefined;
  const s = name.toLowerCase();
  // Exact match
  const exact = availableOptions.find((o) => o.toLowerCase() === s);
  if (exact) return exact;
  // Contains match
  const contains = availableOptions.find(
    (o) => o.toLowerCase().includes(s) || s.includes(o.toLowerCase()),
  );
  if (contains) return contains;
  // Alias match via tag category, find sibling names in the same group
  const tag = getFanSpeedTag(name, customTags);
  if (tag !== undefined) {
    const group = FAN_TAG_PATTERNS.find((p) => p.tag === tag);
    if (group) {
      const aliases = group.pattern.source
        .replace(/^\^\(|\)\$$/g, "")
        .split("|");
      for (const a of aliases) {
        const m = availableOptions.find(
          (o) => o.toLowerCase() === a || o.toLowerCase().includes(a),
        );
        if (m) return m;
      }
    }
  }
  return undefined;
}

/**
 * Derive the cleaning mode select entity ID from the vacuum entity ID.
 */
function deriveCleaningModeSelectEntity(vacuumEntityId: string): string {
  const vacuumName = vacuumEntityId.replace("vacuum.", "");
  return `select.${vacuumName}_cleaning_mode`;
}

function getCleaningModeSelectEntity(agent: Agent): string {
  const ha = agent.get(HomeAssistantEntityBehavior);
  const mapping = ha.state.mapping;
  if (mapping?.cleaningModeEntity) return mapping.cleaningModeEntity;
  return deriveCleaningModeSelectEntity(ha.entityId);
}

function readSelectEntity(
  entityId: string,
  agent: Agent,
): { state?: string; options?: string[] } {
  const stateProvider = agent.env.get(EntityStateProvider);
  const entityState = stateProvider.getState(entityId);
  if (!entityState) return {};
  const attrs = entityState.attributes as { options?: string[] } | undefined;
  return {
    state: entityState.state as string | undefined,
    options: attrs?.options,
  };
}

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

function createCleanModeConfig(
  fanSpeedList?: string[],
  mopIntensityList?: string[],
  cleaningModeOptions?: string[],
  customFanSpeedTags?: Record<string, number>,
) {
  const hasCleanTypes = !!cleaningModeOptions && cleaningModeOptions.length > 0;
  return {
    getCurrentMode: (entity: { attributes: unknown }, agent: Agent): number => {
      const attributes = entity.attributes as VacuumDeviceAttributes & {
        cleaning_mode?: string;
      };

      // Determine cleaning type from select entity or vacuum attribute.
      // Without cleaning type support, default to Sweeping (fan-speed only).
      let cleanType: CleanType = CleanType.Sweeping;
      if (hasCleanTypes) {
        if (attributes.cleaning_mode) {
          cleanType = parseCleanType(attributes.cleaning_mode);
        } else {
          const selectEntityId = getCleaningModeSelectEntity(agent);
          const { state } = readSelectEntity(selectEntityId, agent);
          cleanType = parseCleanType(state);
        }
      }

      const mapping = agent.get(HomeAssistantEntityBehavior).state.mapping;

      // Fan-speed intensity: when vacuuming, check suction/fan speed
      if (
        cleanType === CleanType.Sweeping &&
        fanSpeedList &&
        fanSpeedList.length > 0
      ) {
        let speedState: string | undefined;
        let entityOptions: string[] | undefined;
        if (mapping?.suctionLevelEntity) {
          const sel = readSelectEntity(mapping.suctionLevelEntity, agent);
          speedState = sel.state;
          entityOptions = sel.options;
        } else {
          speedState =
            (attributes.fan_speed as string | undefined) ?? undefined;
        }
        let speedMode = fanSpeedToModeId(speedState, fanSpeedList);
        // Positional fallback: entity option names may differ from
        // fan_speed_list (e.g. "quiet" vs "Silent"). Match by index.
        if (speedMode === undefined && speedState && entityOptions) {
          const idx = entityOptions.findIndex(
            (o) => o.toLowerCase() === speedState!.toLowerCase(),
          );
          if (idx >= 0 && idx < fanSpeedList.length) {
            speedMode = FAN_SPEED_MODE_BASE + idx;
          }
        }
        if (speedMode !== undefined) {
          logger.debug(
            `Current mode: Vacuum + fan_speed="${speedState}" -> mode ${speedMode}`,
          );
          return speedMode;
        }
      }

      // Mop intensity: when mopping, check mop intensity entity
      if (
        cleanType === CleanType.Mopping &&
        mopIntensityList &&
        mopIntensityList.length > 0 &&
        mapping?.mopIntensityEntity
      ) {
        const { state, options } = readSelectEntity(
          mapping.mopIntensityEntity,
          agent,
        );
        let mopMode = mopIntensityToModeId(state, mopIntensityList);
        // Positional fallback: entity option names may differ from
        // mopIntensityList (e.g. "moist" vs "medium"). Match by index.
        if (mopMode === undefined && state && options) {
          const idx = options.findIndex(
            (o) => o.toLowerCase() === state!.toLowerCase(),
          );
          if (idx >= 0 && idx < mopIntensityList.length) {
            mopMode = MOP_INTENSITY_MODE_BASE + idx;
          }
        }
        if (mopMode !== undefined) {
          logger.debug(
            `Current mode: Mop + intensity="${state}" -> mode ${mopMode}`,
          );
          return mopMode;
        }
      }

      return cleanTypeToModeId(cleanType);
    },

    getSupportedModes: () =>
      buildSupportedModes(
        fanSpeedList,
        mopIntensityList,
        cleaningModeOptions,
        customFanSpeedTags,
      ),

    setCleanMode: (mode: number, agent: Agent) => {
      const homeAssistant = agent.get(HomeAssistantEntityBehavior);
      const vacuumEntityId = homeAssistant.entityId;
      const mapping = homeAssistant.state.mapping;

      logger.info(
        `setCleanMode(${mode}) for ${vacuumEntityId}, ` +
          `suctionEntity=${mapping?.suctionLevelEntity ?? "none"}, ` +
          `mopEntity=${mapping?.mopIntensityEntity ?? "none"}, ` +
          `fanSpeedList=${JSON.stringify(fanSpeedList ?? [])}, ` +
          `mopIntensityList=${JSON.stringify(mopIntensityList ?? [])}, ` +
          `customTags=${JSON.stringify(customFanSpeedTags ?? {})}`,
      );

      // Mop-intensity modes: switch to mopping first, then set intensity
      if (
        mopIntensityList &&
        mopIntensityList.length > 0 &&
        isMopIntensityMode(mode)
      ) {
        const mopIndex = mode - MOP_INTENSITY_MODE_BASE;
        const mopName = mopIntensityList[mopIndex];
        if (!mopName) {
          logger.warn(`Invalid mop intensity mode index: ${mopIndex}`);
          return undefined;
        }

        // Ensure cleaning mode is mopping before setting intensity.
        // Dreame makes the mop entity unavailable while in vacuum mode,
        // so the cleaning mode must change first.
        if (hasCleanTypes) {
          homeAssistant.callAction(
            buildCleaningModeAction(CleanType.Mopping, agent),
          );
        }

        if (mapping?.mopIntensityEntity) {
          const { state, options } = readSelectEntity(
            mapping.mopIntensityEntity,
            agent,
          );
          logger.info(
            `Mop intensity entity ${mapping.mopIntensityEntity}: ` +
              `current="${state}", options=${JSON.stringify(options ?? [])}`,
          );
          let option = matchMopIntensityOption(mopName, options);
          // Positional fallback: generic names (low/medium/high) may not
          // match entity options (slightly_dry/moist/wet). Use same index.
          if (!option && options && mopIndex < options.length) {
            option = options[mopIndex];
            logger.info(
              `Positional match for mop "${mopName}" -> "${option}" (index ${mopIndex})`,
            );
          }
          if (option) {
            logger.info(
              `Setting mop intensity to: ${option} via ${mapping.mopIntensityEntity}`,
            );
            return {
              action: "select.select_option",
              data: { option },
              target: mapping.mopIntensityEntity,
            };
          }
          logger.warn(
            `No match for mop intensity "${mopName}" in options: ` +
              `[${(options ?? []).join(", ")}]`,
          );
        } else {
          logger.warn(
            `Mop intensity mode ${mode} requested but no mopIntensityEntity configured`,
          );
        }
        return undefined;
      }

      // Fan-speed modes: set suction/fan speed and switch cleaning mode
      if (fanSpeedList && fanSpeedList.length > 0 && isFanSpeedMode(mode)) {
        const fanSpeedIndex = mode - FAN_SPEED_MODE_BASE;
        const fanSpeedName = fanSpeedList[fanSpeedIndex];
        if (!fanSpeedName) {
          logger.warn(`Invalid fan speed mode index: ${fanSpeedIndex}`);
          return undefined;
        }

        // Use suctionLevelEntity if configured
        if (mapping?.suctionLevelEntity) {
          // Ensure cleaning mode is sweeping before setting suction.
          // Dreame makes the suction entity unavailable while in mop mode.
          if (hasCleanTypes) {
            homeAssistant.callAction(
              buildCleaningModeAction(CleanType.Sweeping, agent),
            );
          }

          const { state, options } = readSelectEntity(
            mapping.suctionLevelEntity,
            agent,
          );
          logger.info(
            `Suction entity ${mapping.suctionLevelEntity}: ` +
              `current="${state}", options=${JSON.stringify(options ?? [])}`,
          );
          let option = matchFanSpeedOption(
            fanSpeedName,
            options,
            customFanSpeedTags,
          );
          // Positional fallback: fan_speed_list names (Silent/Strong) may
          // differ from suction entity options (quiet/strong). Use same index.
          if (!option && options && fanSpeedIndex < options.length) {
            option = options[fanSpeedIndex];
            logger.info(
              `Positional match for fan "${fanSpeedName}" -> "${option}" (index ${fanSpeedIndex})`,
            );
          }
          if (option) {
            logger.info(
              `Setting suction to: ${option} via ${mapping.suctionLevelEntity}`,
            );
            return {
              action: "select.select_option",
              data: { option },
              target: mapping.suctionLevelEntity,
            };
          }
          logger.warn(
            `No match for fan speed "${fanSpeedName}" in suction options: ` +
              `[${(options ?? []).join(", ")}]`,
          );
          return undefined;
        }

        // Otherwise use vacuum.set_fan_speed with the original name
        if (hasCleanTypes) {
          homeAssistant.callAction(
            buildCleaningModeAction(CleanType.Sweeping, agent),
          );
        }
        logger.info(
          `Setting fan speed to: ${fanSpeedName} via vacuum.set_fan_speed`,
        );
        return {
          action: "vacuum.set_fan_speed",
          data: { fan_speed: fanSpeedName },
          target: vacuumEntityId,
        };
      }

      // Cleaning-type modes: set the cleaning mode select entity
      if (!hasCleanTypes) {
        logger.debug(
          `Ignoring cleaning type change (mode=${mode}): no cleaning mode entity`,
        );
        return undefined;
      }

      const cleanType = modeIdToCleanType(mode);
      const selectEntityId = getCleaningModeSelectEntity(agent);
      const { options: availableOptions } = readSelectEntity(
        selectEntityId,
        agent,
      );
      const optionToUse = findMatchingCleanOption(cleanType, availableOptions);

      logger.info(
        `Setting cleaning mode to: ${optionToUse} (mode=${mode}) via ${selectEntityId}`,
      );

      return {
        action: "select.select_option",
        data: { option: optionToUse },
        target: selectEntityId,
      };
    },
  };
}

/**
 * Create a VacuumRvcCleanModeServer with cleaning modes.
 * Fan-speed modes are generated dynamically from the fanSpeedList.
 * Mop-intensity modes are generated dynamically from the mopIntensityList.
 * Apple Home shows them as "extra features" in the vacuum control panel.
 */
export function createVacuumRvcCleanModeServer(
  _attributes: VacuumDeviceAttributes,
  fanSpeedList?: string[],
  mopIntensityList?: string[],
  cleaningModeOptions?: string[],
  customFanSpeedTags?: Record<string, number>,
): ReturnType<typeof RvcCleanModeServer> {
  const supportedModes = buildSupportedModes(
    fanSpeedList,
    mopIntensityList,
    cleaningModeOptions,
    customFanSpeedTags,
  );

  logger.info(
    `Creating VacuumRvcCleanModeServer with ${supportedModes.length} modes (fanSpeedList=${JSON.stringify(fanSpeedList ?? [])}, ` +
      `mopIntensityList=${JSON.stringify(mopIntensityList ?? [])}, ` +
      `cleaningModeOptions=${JSON.stringify(cleaningModeOptions ?? [])}, ` +
      `customTags=${JSON.stringify(customFanSpeedTags ?? {})})`,
  );
  logger.info(
    `Modes: ${supportedModes.map((m) => `${m.mode}:${m.label}[${m.modeTags.map((t) => t.value).join(",")}]`).join(", ")}`,
  );

  const initialState: RvcCleanModeServerInitialState = {
    supportedModes,
    currentMode: MODE_VACUUM,
  };

  return RvcCleanModeServer(
    createCleanModeConfig(
      fanSpeedList,
      mopIntensityList,
      cleaningModeOptions,
      customFanSpeedTags,
    ),
    initialState,
  );
}

/**
 * Create a default RvcCleanMode server with a single "Vacuum" mode.
 * Used for vacuums that don't support multiple cleaning modes
 * (e.g. Roborock via Xiaomi integration, iRobot Roomba, etc.).
 *
 * Alexa probes for RvcCleanMode (0x55) during device discovery.
 * Without it, Alexa may fail to complete CASE session establishment
 * and never subscribe, leaving the vacuum undiscoverable.
 */
export function createDefaultRvcCleanModeServer(): ReturnType<
  typeof RvcCleanModeServer
> {
  const defaultConfig = {
    getCurrentMode: () => MODE_VACUUM,
    getSupportedModes: (): RvcCleanMode.ModeOption[] => [
      {
        label: "Vacuum",
        mode: MODE_VACUUM,
        modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }],
      },
    ],
    setCleanMode: () => undefined,
  };

  return RvcCleanModeServer(defaultConfig, {
    supportedModes: [
      {
        label: "Vacuum",
        mode: MODE_VACUUM,
        modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }],
      },
    ],
    currentMode: MODE_VACUUM,
  });
}

/**
 * Check if vacuum supports cleaning modes.
 * Dreame and Ecovacs vacuums typically support vacuum/mop/both modes
 * via a separate select entity (e.g., select.vacuum_cleaning_mode).
 */
export function supportsCleaningModes(
  attributes: VacuumDeviceAttributes,
): boolean {
  return isDreameVacuum(attributes) || isEcovacsVacuum(attributes);
}

/**
 * Check if vacuum has fan speed options available.
 * Used to auto-detect fan speed support without requiring manual
 * suctionLevelEntity configuration.
 */
export function hasFanSpeedSupport(
  attributes: VacuumDeviceAttributes,
): boolean {
  return !!attributes.fan_speed_list && attributes.fan_speed_list.length > 1;
}

/**
 * Resolve the fan speed list for vacuum clean mode generation.
 * Uses fan_speed_list from vacuum attributes when available,
 * falls back to generic speeds when suctionLevelEntity is configured.
 */
export function resolveFanSpeedList(
  attributes: VacuumDeviceAttributes,
  suctionLevelEntity?: string,
): string[] | undefined {
  if (attributes.fan_speed_list && attributes.fan_speed_list.length > 1) {
    return attributes.fan_speed_list;
  }
  if (suctionLevelEntity) {
    return ["quiet", "standard", "strong"];
  }
  return undefined;
}

/**
 * Resolve the mop intensity list for vacuum clean mode generation.
 * Returns generic mop intensity options when mopIntensityEntity is configured.
 * At runtime, the actual entity options are read and matched via getMopIntensityTag.
 */
export function resolveMopIntensityList(
  mopIntensityEntity?: string,
): string[] | undefined {
  if (mopIntensityEntity) {
    return ["low", "medium", "high"];
  }
  return undefined;
}
