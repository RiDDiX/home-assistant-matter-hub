import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Bytes, Logger } from "@matter/general";
import { ThermostatServer as MatterThermostatServer } from "@matter/main/behaviors";
import { Thermostat } from "@matter/main/clusters";
import {
  AppleThermostatServerBase,
  isAdaptiveTemperatureEnabled,
  nowEpochS,
  toNullableEpochS,
} from "./apple-adaptive-temperature.js";

const logger = Logger.get("ThermostatServer");

import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { Temperature } from "../../utils/converters/temperature.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import SystemMode = Thermostat.SystemMode;
import RunningMode = Thermostat.ThermostatRunningMode;

import type { ActionContext, Agent } from "@matter/main";
import { StatusCode, StatusResponseError } from "@matter/main/types";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";

interface ThermostatRuntimeState {
  nudgingSetpoints: boolean;
  activatingPreset: boolean;
  lastPresetActivation?: { handle: Bytes | null; at: number };
  lastObservedSystemMode?: SystemMode;
  prevPersistedPresets?: Thermostat.Preset[];
  nudgedHeat?: number;
  nudgedCool?: number;
  autoResuming?: { mode: SystemMode; at: number };
  holdTimer?: ReturnType<typeof setTimeout>;
  holdGeneration: number;
}

// Scoped per Matter endpoint object (WeakMap) so identical entityIds across
// multiple bridges never collide and closed/deleted endpoints GC cleanly.
const endpointRuntimeStates = new WeakMap<
  object,
  Map<string, ThermostatRuntimeState>
>();

function getRuntimeState(
  self: { endpoint: object },
  entityId: string,
): ThermostatRuntimeState {
  let byEntity = endpointRuntimeStates.get(self.endpoint);
  if (!byEntity) {
    byEntity = new Map();
    endpointRuntimeStates.set(self.endpoint, byEntity);
  }
  let state = byEntity.get(entityId);
  if (!state) {
    state = {
      nudgingSetpoints: false,
      activatingPreset: false,
      holdGeneration: 0,
    };
    byEntity.set(entityId, state);
  }
  return state;
}

function clearHoldTimer(runtime: ThermostatRuntimeState): void {
  runtime.holdGeneration++;
  if (runtime.holdTimer !== undefined) {
    clearTimeout(runtime.holdTimer);
    runtime.holdTimer = undefined;
  }
}

function clearEndpointHoldTimers(endpoint?: object): void {
  if (!endpoint) return;
  const byEntity = endpointRuntimeStates.get(endpoint);
  if (!byEntity) return;
  for (const runtime of byEntity.values()) {
    clearHoldTimer(runtime);
  }
  endpointRuntimeStates.delete(endpoint);
}

function setHoldAttr(
  state: Record<string, unknown>,
  tx: object | undefined,
  attr: HoldTrackedAttr,
  value: unknown,
): void {
  if (state[attr] === undefined || Object.is(state[attr], value)) {
    return;
  }
  recordInternalWrite(internalHoldWritesByTx, tx, attr, value);
  state[attr] = value;
}

function clearHoldState(
  state: unknown,
  runtime?: ThermostatRuntimeState,
  options?: { clearAppleOverride?: boolean; setHoldOff?: boolean; tx?: object },
): void {
  if (runtime) {
    clearHoldTimer(runtime);
  }
  const s = state as Record<string, unknown>;
  const tx = options?.tx;
  if (options?.setHoldOff !== false) {
    setHoldAttr(
      s,
      tx,
      "temperatureSetpointHold",
      Thermostat.TemperatureSetpointHold.SetpointHoldOff,
    );
  }
  setHoldAttr(s, tx, "temperatureSetpointHoldDuration", null);
  if (s.setpointHoldExpiryTimestamp !== undefined) {
    s.setpointHoldExpiryTimestamp = null;
  }
  if (options?.clearAppleOverride !== false) {
    if (s.appleAttr000C !== undefined) {
      s.appleAttr000C = null;
    }
    setHoldAttr(s, tx, "appleAttr000E", true);
  }
}

function clearApplePresetTracking(
  state: unknown,
  runtime?: ThermostatRuntimeState,
  tx?: object,
): void {
  clearHoldState(state, runtime, { tx });
  const meiState = state as Record<string, unknown>;
  if (meiState.appleAttr0009 !== undefined) {
    meiState.appleAttr0009 = null;
  }
  if (meiState.appleAttr000B !== undefined) {
    meiState.appleAttr000B = null;
  }
}

function cloneBytes(value: Bytes): Uint8Array {
  return Bytes.of(value).slice();
}

function enterAppleHold(
  state: unknown,
  runtime: ThermostatRuntimeState,
  options: {
    source: Thermostat.SetpointChangeSource;
    amount?: number | null;
    scheduledPresetHandle?: Bytes | null;
    tx?: object;
  },
): void {
  const s = state as Record<string, unknown>;
  if (s.setpointChangeSource !== undefined) {
    s.setpointChangeSource = options.source;
    if (s.setpointChangeAmount !== undefined) {
      // Matter.js nullable int16 reserves -32768 (0x8000) as null sentinel.
      s.setpointChangeAmount =
        typeof options.amount === "number" && Number.isFinite(options.amount)
          ? Math.max(-32767, Math.min(32767, Math.trunc(options.amount)))
          : null;
    }
    if (s.setpointChangeSourceTimestamp !== undefined) {
      s.setpointChangeSourceTimestamp = nowEpochS();
    }
  }

  const adaptiveEnabled = isAdaptiveTemperatureEnabled(s);
  const scheduledHandle =
    (s.activePresetHandle as Bytes | null | undefined) ??
    options.scheduledPresetHandle ??
    (s.appleAttr0009 as Bytes | null | undefined) ??
    null;

  if (
    s.temperatureSetpointHold ===
    Thermostat.TemperatureSetpointHold.SetpointHoldOn
  ) {
    if (adaptiveEnabled && s.appleAttr000C !== undefined) {
      s.appleAttr000C = 2;
    }
    if (
      adaptiveEnabled &&
      s.appleAttr0009 !== undefined &&
      (s.activePresetHandle != null || options.scheduledPresetHandle != null) &&
      scheduledHandle !== null
    ) {
      s.appleAttr0009 = cloneBytes(scheduledHandle);
    }
    return;
  }

  if (!adaptiveEnabled || scheduledHandle === null) {
    clearHoldState(s, runtime, { tx: options.tx });
    return;
  }

  if (
    s.appleAttr0009 !== undefined &&
    (s.activePresetHandle != null || options.scheduledPresetHandle != null)
  ) {
    s.appleAttr0009 = cloneBytes(scheduledHandle);
  }
  clearHoldState(s, runtime, { setHoldOff: false, tx: options.tx });
  if (s.appleAttr000C !== undefined) {
    s.appleAttr000C = 2;
  }
  setHoldAttr(
    s,
    options.tx,
    "temperatureSetpointHold",
    Thermostat.TemperatureSetpointHold.SetpointHoldOn,
  );
}

function applyHoldDuration(
  // biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
  self: any,
  runtime: ThermostatRuntimeState,
  opts: {
    durationMinutes: number | null | undefined;
    resumeOnNextEvent?: boolean;
    setHoldOn?: boolean;
    updateAppleMei: boolean;
    tx?: object;
  },
): void {
  const s = self.state as Record<string, unknown>;
  if (opts.updateAppleMei) {
    const prevHandle = self.state.activePresetHandle as Bytes | null;
    if (prevHandle !== null && s.appleAttr0009 !== undefined) {
      s.appleAttr0009 = cloneBytes(prevHandle);
    }
    self.state.activePresetHandle = null;
    if (s.appleAttr000C !== undefined) {
      s.appleAttr000C = 2;
    }
    if (opts.resumeOnNextEvent !== undefined) {
      setHoldAttr(s, opts.tx, "appleAttr000E", opts.resumeOnNextEvent);
    }
  } else if (opts.setHoldOn && self.state.activePresetHandle !== null) {
    self.state.activePresetHandle = null;
  }

  if (opts.setHoldOn) {
    setHoldAttr(
      s,
      opts.tx,
      "temperatureSetpointHold",
      Thermostat.TemperatureSetpointHold.SetpointHoldOn,
    );
  }

  if (
    opts.resumeOnNextEvent !== true &&
    opts.durationMinutes != null &&
    opts.durationMinutes > 0
  ) {
    const clampedMin = Math.min(1440, Math.trunc(opts.durationMinutes));
    const nowMs = Date.now();
    const expiryUnixSec = toNullableEpochS(
      Math.floor(nowMs / 1000) + clampedMin * 60,
    );
    setHoldAttr(s, opts.tx, "temperatureSetpointHoldDuration", clampedMin);
    if (s.setpointHoldExpiryTimestamp !== undefined) {
      s.setpointHoldExpiryTimestamp = expiryUnixSec;
    }
    scheduleHoldExpiry(self, runtime, nowMs + clampedMin * 60_000);
    return;
  }

  clearHoldTimer(runtime);
  if (opts.durationMinutes === null || opts.resumeOnNextEvent === true) {
    setHoldAttr(s, opts.tx, "temperatureSetpointHoldDuration", null);
  }
  if (s.setpointHoldExpiryTimestamp !== undefined) {
    s.setpointHoldExpiryTimestamp = null;
  }
}

function resumeScheduledPresetOrClearHold(
  // biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
  self: any,
  runtime: ThermostatRuntimeState,
): void {
  clearHoldTimer(runtime);
  const state = self.state as Record<string, unknown>;
  const scheduledHandle = state.appleAttr0009;
  const persistedPresets = state.persistedPresets as
    | Thermostat.Preset[]
    | undefined;
  const homeAssistant = self.agent?.get?.(HomeAssistantEntityBehavior) as
    | { isAvailable?: boolean }
    | undefined;
  const hasScheduledPreset =
    isAdaptiveTemperatureEnabled(state) &&
    Bytes.isBytes(scheduledHandle) &&
    (homeAssistant?.isAvailable ?? true) &&
    persistedPresets?.some(
      (p) =>
        p.presetHandle !== null &&
        Bytes.areEqual(p.presetHandle, scheduledHandle),
    );

  if (hasScheduledPreset && typeof self.setActivePresetRequest === "function") {
    const prevScheduledExpiry =
      typeof state.appleAttr000B === "number" &&
      state.appleAttr000B > Math.floor(Date.now() / 1000)
        ? state.appleAttr000B
        : null;
    self.setActivePresetRequest({
      presetHandle: cloneBytes(scheduledHandle),
    });
    if (prevScheduledExpiry !== null && state.appleAttr000B !== undefined) {
      state.appleAttr000B = prevScheduledExpiry;
    }
    return;
  }

  clearHoldState(state, runtime);
}

function scheduleHoldExpiry(
  // biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
  self: any,
  runtime: ThermostatRuntimeState,
  targetMs: number,
): void {
  clearHoldTimer(runtime);
  const gen = runtime.holdGeneration;
  const endpoint = self?.endpoint;
  const behaviorType = self?.type;
  if (!endpoint || !behaviorType || endpoint.lifecycle?.isGone) {
    return;
  }

  const armTimer = () => {
    if (runtime.holdGeneration !== gen || endpoint.lifecycle?.isGone) {
      return;
    }
    const delayMs = Math.max(0, Math.min(targetMs - Date.now(), 2_147_483_647));
    runtime.holdTimer = setTimeout(() => {
      runtime.holdTimer = undefined;
      if (runtime.holdGeneration !== gen || endpoint.lifecycle?.isGone) {
        return;
      }
      if (!endpoint.lifecycle?.isReady) {
        if (typeof endpoint.lifecycle?.ready?.once === "function") {
          endpoint.lifecycle.ready.once(() => {
            if (runtime.holdGeneration === gen && !endpoint.lifecycle?.isGone) {
              armTimer();
            }
          });
        }
        return;
      }
      // Handle holds >24.8 days (exceeding Node's 32-bit setTimeout cap).
      if (targetMs - Date.now() > 1000) {
        armTimer();
        return;
      }
      void Promise.resolve(
        endpoint.act(async (agent: Agent) => {
          if (runtime.holdGeneration !== gen || endpoint.lifecycle?.isGone) {
            return;
          }
          // biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
          const behavior = agent.get(behaviorType) as any;
          if (typeof agent.context?.transaction?.lock === "function") {
            await agent.context.transaction.lock(behavior);
          }
          if (runtime.holdGeneration !== gen || endpoint.lifecycle?.isGone) {
            return;
          }
          const state = behavior.state as Record<string, unknown>;
          if (
            state.temperatureSetpointHold !==
            Thermostat.TemperatureSetpointHold.SetpointHoldOn
          ) {
            return;
          }
          if (
            typeof state.setpointHoldExpiryTimestamp === "number" &&
            state.setpointHoldExpiryTimestamp >
              Math.floor(Date.now() / 1000) + 1
          ) {
            scheduleHoldExpiry(
              behavior,
              runtime,
              state.setpointHoldExpiryTimestamp * 1000,
            );
            return;
          }
          resumeScheduledPresetOrClearHold(behavior, runtime);
        }),
      ).catch((err: unknown) => {
        logger.warn("[APPLE-MEI] Failed to expire setpoint hold:", err);
      });
    }, delayMs);
    runtime.holdTimer.unref?.();
  };

  if (
    !endpoint.lifecycle?.isReady &&
    typeof endpoint.lifecycle?.ready?.once === "function"
  ) {
    endpoint.lifecycle.ready.once(() => {
      if (runtime.holdGeneration === gen && !endpoint.lifecycle?.isGone) {
        armTimer();
      }
    });
    return;
  }
  armTimer();
}

type HoldTrackedAttr =
  | "temperatureSetpointHold"
  | "temperatureSetpointHoldDuration"
  | "appleAttr000E";
type SetpointTrackedKind = "heat" | "cool";

// Per-(transaction, attribute) expected values written internally by preset/hold handlers.
// Matter.js reuses the same Transaction object across attributes in a multi-attribute WriteRequest,
// so consuming per attribute ensures chained internal cascades are suppressed without swallowing
// sibling controller writes in the same packet.
const internalHoldWritesByTx = new WeakMap<
  object,
  Map<HoldTrackedAttr, unknown>
>();
const internalSetpointWritesByTx = new WeakMap<
  object,
  Map<SetpointTrackedKind, number>
>();

function recordInternalWrite<K extends string, V>(
  store: WeakMap<object, Map<K, V>>,
  tx: object | undefined,
  key: K,
  value: V,
): void {
  if (!tx) return;
  let map = store.get(tx);
  if (!map) {
    map = new Map();
    store.set(tx, map);
  }
  map.set(key, value);
}

function consumeInternalWrite<K extends string, V>(
  store: WeakMap<object, Map<K, V>>,
  tx: object | undefined,
  key: K,
  value: V,
): boolean {
  if (!tx) return false;
  const map = store.get(tx);
  if (!map?.has(key)) return false;
  const expected = map.get(key);
  map.delete(key);
  return Object.is(expected, value);
}

// Intended active preset handle per (transaction, endpointKey) to restore activePresetHandle
// if Matter.js's assertOccupied*SetpointChanging resets it to null in pre-commit.
const intendedActivePresetByTx = new WeakMap<
  object,
  Map<string, Bytes | null>
>();

const endpointUidMap = new WeakMap<object, number>();
let nextEndpointUid = 1;

function txKey(
  self: { endpoint?: object } | undefined,
  entityId: string,
): string {
  const ep = self?.endpoint;
  if (!ep) return entityId;
  let uid = endpointUidMap.get(ep);
  if (uid === undefined) {
    uid = nextEndpointUid++;
    endpointUidMap.set(ep, uid);
  }
  return `${uid}:${entityId}`;
}

function setIntendedPresetForTx(
  tx: object | undefined,
  key: string,
  handle: Bytes | null,
): void {
  if (!tx) return;
  let map = intendedActivePresetByTx.get(tx);
  if (!map) {
    map = new Map();
    intendedActivePresetByTx.set(tx, map);
  }
  map.set(key, handle);
}

function getIntendedPresetForTx(
  tx: object | undefined,
  key: string,
): Bytes | null | undefined {
  if (!tx) return undefined;
  return intendedActivePresetByTx.get(tx)?.get(key);
}

// An auto-resume entry older than AUTO_RESUME_MS is stale and must not swallow
// a later controller write of that mode (#519).
const AUTO_RESUME_MS = 2000;
// Ecobee/HomeKit bridges can take ~3s to echo mode/setpoint settles back into HA.
const PRESET_ECHO_WINDOW_MS = 8000;
const SETPOINT_MATCH_TOLERANCE_CENTIDEGREES = 60;

/**
 * Nudge a setpoint by +1 centidegree (0.01°C) so that any controller write
 * of the "real" value produces a value change and triggers $Changing.
 * If already at the max limit, nudge -1 instead to stay within bounds.
 */
function nudgeSetpoint(value: number | undefined, maxLimit: number): number {
  if (value == null) return 2000; // fallback 20°C
  return value >= maxLimit ? value - 1 : value + 1;
}

// For dual-mode thermostats (heating + cooling), AutoMode is ENABLED so Apple Home
// can offer Auto mode and dual setpoints. Without AutoMode, Apple Home loses Auto.
//
// localTemperature: null when current_temperature is unavailable (not setpoint!)
//   Apple Home uses localTemp vs setpoint comparison for "Heating to..." display.
//   Setting localTemp = setpoint makes Apple Home think target is already reached.
// thermostatRunningMode: Set ONLY for Auto mode from hvac_action. Matter.js reactor
//   handles Heat/Cool/Off but SKIPS Auto, without our update, switching Heat→Auto
//   leaves runningMode stale at Heat. (889010b: all modes = conflict, 0678d35: none
//   = stale, da04b2e: Auto only = correct)
// thermostatRunningState: Set from hvac_action for controllers that support it.
//
// For heat-only / cool-only devices, AutoMode is NOT enabled:
// - Prevents Alexa from expecting dual setpoints (→ "not supported" errors)

// Default state values for each feature combination.
// These MUST be set via .set() when creating the behavior class because Matter.js
// validates setpoints before our initialize() method runs.
//
// thermostatRunningState (optional attribute) MUST be initialized here so
// controllers discover and subscribe to it from the start. Without this,
// Apple Home cannot distinguish "Heating to 26" (active) from "Heat to 26" (idle).
const runningStateAllOff = {
  heat: false,
  cool: false,
  fan: false,
  heatStage2: false,
  coolStage2: false,
  fanStage2: false,
  fanStage3: false,
};

const standardPresetTypes: Thermostat.PresetType[] = [
  {
    presetScenario: Thermostat.PresetScenario.Occupied,
    numberOfPresets: 1,
    presetTypeFeatures: { automatic: true, supportsNames: true },
  },
  {
    presetScenario: Thermostat.PresetScenario.Unoccupied,
    numberOfPresets: 1,
    presetTypeFeatures: { automatic: true, supportsNames: true },
  },
  {
    presetScenario: Thermostat.PresetScenario.Sleep,
    numberOfPresets: 1,
    presetTypeFeatures: { automatic: true, supportsNames: true },
  },
  {
    presetScenario: Thermostat.PresetScenario.Vacation,
    numberOfPresets: 1,
    presetTypeFeatures: { automatic: true, supportsNames: true },
  },
  {
    presetScenario: Thermostat.PresetScenario.GoingToSleep,
    numberOfPresets: 1,
    presetTypeFeatures: { automatic: true, supportsNames: true },
  },
  {
    presetScenario: Thermostat.PresetScenario.UserDefined,
    numberOfPresets: 5,
    presetTypeFeatures: { automatic: true, supportsNames: true },
  },
];

export function createPresetHandle(scenario: number): Uint8Array {
  switch (scenario) {
    case Thermostat.PresetScenario.Occupied:
      return new Uint8Array([1]);
    case Thermostat.PresetScenario.Unoccupied:
      return new Uint8Array([2]);
    case Thermostat.PresetScenario.GoingToSleep:
      return new Uint8Array([3]);
    case Thermostat.PresetScenario.Sleep:
      return new Uint8Array([4]);
    case Thermostat.PresetScenario.Vacation:
      return new Uint8Array([5]);
    default:
      return new Uint8Array([scenario]);
  }
}

function defaultHeatForScenario(scenario: number): number {
  switch (scenario) {
    case Thermostat.PresetScenario.Occupied:
      return 2000;
    case Thermostat.PresetScenario.Unoccupied:
      return 1600;
    case Thermostat.PresetScenario.GoingToSleep:
      return 2000;
    case Thermostat.PresetScenario.Sleep:
      return 1800;
    case Thermostat.PresetScenario.Vacation:
      return 1000;
    default:
      return 2000;
  }
}

function defaultCoolForScenario(scenario: number): number {
  switch (scenario) {
    case Thermostat.PresetScenario.Occupied:
      return 2333;
    case Thermostat.PresetScenario.Unoccupied:
      return 2900;
    case Thermostat.PresetScenario.GoingToSleep:
      return 2388;
    case Thermostat.PresetScenario.Sleep:
      return 2500;
    case Thermostat.PresetScenario.Vacation:
      return 2900;
    default:
      return 2400;
  }
}

export function targetModeForActiveSystemMode(
  systemMode: SystemMode,
  hasHeating: boolean,
  hasCooling: boolean,
): Thermostat.SetpointRaiseLowerMode {
  if (
    systemMode === SystemMode.Cool ||
    systemMode === SystemMode.Precooling ||
    !hasHeating
  ) {
    return Thermostat.SetpointRaiseLowerMode.Cool;
  }
  if (
    systemMode === SystemMode.Heat ||
    systemMode === SystemMode.EmergencyHeat ||
    !hasCooling
  ) {
    return Thermostat.SetpointRaiseLowerMode.Heat;
  }
  return hasCooling
    ? Thermostat.SetpointRaiseLowerMode.Cool
    : Thermostat.SetpointRaiseLowerMode.Heat;
}

export function createStandardPresets(
  hasHeating: boolean,
  hasCooling: boolean,
): Thermostat.Preset[] {
  const definitions = [
    {
      scenario: Thermostat.PresetScenario.Occupied,
      defaultHeat: 2000,
      defaultCool: 2333,
    },
    {
      scenario: Thermostat.PresetScenario.Unoccupied,
      defaultHeat: 1600,
      defaultCool: 2900,
    },
    {
      scenario: Thermostat.PresetScenario.GoingToSleep,
      defaultHeat: 2000,
      defaultCool: 2388,
    },
    {
      scenario: Thermostat.PresetScenario.Sleep,
      defaultHeat: 1800,
      defaultCool: 2500,
    },
    {
      scenario: Thermostat.PresetScenario.Vacation,
      defaultHeat: 1000,
      defaultCool: 2900,
    },
  ];
  return definitions.map((d) => ({
    presetHandle: createPresetHandle(d.scenario),
    presetScenario: d.scenario,
    name: null,
    builtIn: true,
    ...(hasHeating ? { heatingSetpoint: d.defaultHeat } : {}),
    ...(hasCooling ? { coolingSetpoint: d.defaultCool } : {}),
  }));
}

export function repairPreset(
  preset: Thermostat.Preset,
  hasHeating: boolean,
  hasCooling: boolean,
  minHeat: number,
  maxHeat: number,
  minCool: number,
  maxCool: number,
): Thermostat.Preset {
  const defaultHeat = defaultHeatForScenario(preset.presetScenario);
  const defaultCool = defaultCoolForScenario(preset.presetScenario);

  let heatingSetpoint: number | undefined;
  if (hasHeating) {
    const rawHeat = preset.heatingSetpoint ?? defaultHeat;
    heatingSetpoint = Math.max(minHeat, Math.min(maxHeat, rawHeat));
  }

  let coolingSetpoint: number | undefined;
  if (hasCooling) {
    const rawCool = preset.coolingSetpoint ?? defaultCool;
    coolingSetpoint = Math.max(minCool, Math.min(maxCool, rawCool));
  }

  const handle =
    preset.presetHandle ?? createPresetHandle(preset.presetScenario);

  const res: Thermostat.Preset = {
    ...preset,
    presetHandle: handle,
    builtIn: preset.builtIn ?? true,
  };
  if (hasHeating && heatingSetpoint !== undefined) {
    res.heatingSetpoint = heatingSetpoint;
  } else {
    delete res.heatingSetpoint;
  }
  if (hasCooling && coolingSetpoint !== undefined) {
    res.coolingSetpoint = coolingSetpoint;
  } else {
    delete res.coolingSetpoint;
  }
  return res;
}

export function clonePresets(
  presets: Thermostat.Preset[],
): Thermostat.Preset[] {
  return presets.map((p) => ({
    ...p,
    presetHandle: p.presetHandle
      ? new Uint8Array(p.presetHandle as unknown as ArrayLike<number>)
      : null,
  }));
}

const presetDefaults = {
  presetTypes: standardPresetTypes,
  numberOfPresets: 10,
  activePresetHandle: null,
  // Apple Home (iOS 26+) requires standard Matter Setpoint Hold & Change Source
  // attributes (matching Aqara W200 attributeList: 0x0023, 0x0024, 0x0030-0x0032,
  // 0x0052) to render the active Adaptive preset badge ("At Home" / "Night" / etc.).
  temperatureSetpointHold: Thermostat.TemperatureSetpointHold.SetpointHoldOff,
  temperatureSetpointHoldDuration: null,
  setpointHoldExpiryTimestamp: null,
  setpointChangeSource: Thermostat.SetpointChangeSource.Manual,
  setpointChangeAmount: null,
  setpointChangeSourceTimestamp: 946_684_800,
};

const heatingOnlyDefaults = {
  localTemperature: 2100, // 21°C
  occupiedHeatingSetpoint: 2000, // 20°C
  minHeatSetpointLimit: 0,
  maxHeatSetpointLimit: 5000,
  absMinHeatSetpointLimit: 0,
  absMaxHeatSetpointLimit: 5000,
  thermostatRunningState: runningStateAllOff,
};

const coolingOnlyDefaults = {
  localTemperature: 2100, // 21°C
  occupiedCoolingSetpoint: 2400, // 24°C
  minCoolSetpointLimit: 0,
  maxCoolSetpointLimit: 5000,
  absMinCoolSetpointLimit: 0,
  absMaxCoolSetpointLimit: 5000,
  thermostatRunningState: runningStateAllOff,
};

// Full defaults include both heating, cooling, and AutoMode.
// minSetpointDeadBand: 0 allows heat/cool setpoints to be equal (no gap required).
const fullDefaults = {
  ...heatingOnlyDefaults,
  ...coolingOnlyDefaults,
  minSetpointDeadBand: 0,
};

// Heating + Cooling WITHOUT AutoMode. For devices that support both heat and cool
// but not dual setpoints (no heat_cool mode in HA). Apple Home won't show Auto.
const heatingAndCoolingDefaults = {
  ...heatingOnlyDefaults,
  ...coolingOnlyDefaults,
};

// Standard (non-adaptive) bases use Matter.js's standard ThermostatServer without
// Presets or Apple 0x1349 MEI attributes/commands so non-adaptive bridges stay untouched.
// Adaptive bases mount AppleThermostatServerBase + Presets only when opted in.
// Controllers like Alexa use feature flags to determine capabilities (#136).
const StandardHeatingOnlyFeaturedBase =
  MatterThermostatServer.with("Heating").set(heatingOnlyDefaults);
const StandardCoolingOnlyFeaturedBase =
  MatterThermostatServer.with("Cooling").set(coolingOnlyDefaults);
const StandardHeatingAndCoolingFeaturedBase = MatterThermostatServer.with(
  "Heating",
  "Cooling",
).set(heatingAndCoolingDefaults);
const StandardFullFeaturedBase = MatterThermostatServer.with(
  "Heating",
  "Cooling",
  "AutoMode",
).set(fullDefaults);

const AdaptiveHeatingOnlyFeaturedBase = AppleThermostatServerBase.with(
  "Heating",
  "Presets",
).set({ ...heatingOnlyDefaults, ...presetDefaults });
const AdaptiveCoolingOnlyFeaturedBase = AppleThermostatServerBase.with(
  "Cooling",
  "Presets",
).set({ ...coolingOnlyDefaults, ...presetDefaults });
const AdaptiveHeatingAndCoolingFeaturedBase = AppleThermostatServerBase.with(
  "Heating",
  "Cooling",
  "Presets",
).set({ ...heatingAndCoolingDefaults, ...presetDefaults });
const AdaptiveFullFeaturedBase = AppleThermostatServerBase.with(
  "Heating",
  "Cooling",
  "AutoMode",
  "Presets",
).set({ ...fullDefaults, ...presetDefaults });

export interface ThermostatRunningState {
  heat: boolean;
  cool: boolean;
  fan: boolean;
  heatStage2: false;
  coolStage2: false;
  fanStage2: false;
  fanStage3: false;
}

export interface ThermostatServerConfig {
  supportsTemperatureRange: ValueGetter<boolean>;
  getMinTemperature: ValueGetter<Temperature | undefined>;
  getMaxTemperature: ValueGetter<Temperature | undefined>;
  getCurrentTemperature: ValueGetter<Temperature | undefined>;
  getTargetHeatingTemperature: ValueGetter<Temperature | undefined>;
  getTargetCoolingTemperature: ValueGetter<Temperature | undefined>;

  getSystemMode: ValueGetter<SystemMode>;
  getRunningMode: ValueGetter<RunningMode>;
  getControlSequence: ValueGetter<Thermostat.ControlSequenceOfOperation>;

  setSystemMode: ValueSetter<SystemMode>;
  // resumeMode: the mode an auto-resume from Off sent just before (#547).
  setTargetTemperature: (
    value: Temperature,
    agent: Agent,
    resumeMode?: SystemMode,
  ) => HomeAssistantAction;
  setTargetTemperatureRange: ValueSetter<{
    low: Temperature;
    high: Temperature;
  }>;
}

export interface SetpointLimits {
  absMin: number;
  min: number;
  max: number;
  absMax: number;
}

// Make a setpoint-limit set satisfy absMin <= min <= max <= absMax. An old
// build could persist limits in the wrong unit (e.g. 61F stored as 6100 instead
// of 1611), and matter.js keeps the stored value over our defaults, so a stuck
// device fails init every restart until the loaded state is repaired (#375).
export function repairSetpointLimits(limits: SetpointLimits): SetpointLimits {
  let { min, max } = limits;
  if (min > max) [min, max] = [max, min];
  return {
    min,
    max,
    absMin: Math.min(limits.absMin, min),
    absMax: Math.max(limits.absMax, max),
  };
}

// matter.js validates Heat and Cool setpoint state on init no matter the
// featureMap, so limits or an occupied setpoint left over from a former
// heat<->cool config crash a now single-feature device (code 135, #381/#384).
// Clear the inactive scope to undefined, the only value matter.js accepts for a
// disabled attribute, so it falls back to its own defaults.
// biome-ignore lint/suspicious/noExplicitAny: works across feature variants
function clearInactiveSetpointState(self: any, scope: "Heat" | "Cool"): void {
  for (const key of [
    `absMin${scope}SetpointLimit`,
    `min${scope}SetpointLimit`,
    `max${scope}SetpointLimit`,
    `absMax${scope}SetpointLimit`,
    `occupied${scope === "Heat" ? "Heating" : "Cooling"}Setpoint`,
  ]) {
    if (self.state[key] !== undefined) self.state[key] = undefined;
  }
}

/**
 * Pre-super initialization: force-set feature-appropriate attribute values.
 * Must run BEFORE super.initialize() because Matter.js validates setpoints during super.
 * Extracted as standalone function so each feature-variant class can call it
 * from its own initialize() with correct super binding.
 */
// biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
export function thermostatPreInitialize(self: any): void {
  const currentLocal = self.state.localTemperature;

  logger.debug(
    `initialize: features - heating=${self.features.heating}, cooling=${self.features.cooling}`,
  );

  // Force-set local temperature. null is valid per Matter spec (nullable int16).
  const localValue =
    typeof currentLocal === "number" && !Number.isNaN(currentLocal)
      ? currentLocal
      : currentLocal === null
        ? null
        : 2100;
  self.state.localTemperature = localValue;

  // Force-set heating values (only if Heating feature enabled)
  // IMPORTANT: Set limits BEFORE setpoints! Matter.js may validate setpoints
  // against abs limits during property writes. For negative temperatures
  // (e.g. refrigerators at -18°C), the default absMin of 0 would reject the setpoint.
  if (self.features.heating) {
    self.state.absMinHeatSetpointLimit =
      self.state.absMinHeatSetpointLimit ?? 0;
    self.state.absMaxHeatSetpointLimit =
      self.state.absMaxHeatSetpointLimit ?? 5000;
    self.state.minHeatSetpointLimit = self.state.minHeatSetpointLimit ?? 0;
    self.state.maxHeatSetpointLimit = self.state.maxHeatSetpointLimit ?? 5000;

    const heat = repairSetpointLimits({
      absMin: self.state.absMinHeatSetpointLimit,
      min: self.state.minHeatSetpointLimit,
      max: self.state.maxHeatSetpointLimit,
      absMax: self.state.absMaxHeatSetpointLimit,
    });
    self.state.absMinHeatSetpointLimit = heat.absMin;
    self.state.minHeatSetpointLimit = heat.min;
    self.state.maxHeatSetpointLimit = heat.max;
    self.state.absMaxHeatSetpointLimit = heat.absMax;

    const currentHeating = self.state.occupiedHeatingSetpoint;
    const heatingValue =
      typeof currentHeating === "number" && !Number.isNaN(currentHeating)
        ? currentHeating
        : 2000;
    self.state.occupiedHeatingSetpoint = heatingValue;
  } else {
    clearInactiveSetpointState(self, "Heat");
  }

  // Force-set cooling values (only if Cooling feature enabled)
  // Same ordering: limits first, then setpoints.
  if (self.features.cooling) {
    self.state.absMinCoolSetpointLimit =
      self.state.absMinCoolSetpointLimit ?? 0;
    self.state.absMaxCoolSetpointLimit =
      self.state.absMaxCoolSetpointLimit ?? 5000;
    self.state.minCoolSetpointLimit = self.state.minCoolSetpointLimit ?? 0;
    self.state.maxCoolSetpointLimit = self.state.maxCoolSetpointLimit ?? 5000;

    const cool = repairSetpointLimits({
      absMin: self.state.absMinCoolSetpointLimit,
      min: self.state.minCoolSetpointLimit,
      max: self.state.maxCoolSetpointLimit,
      absMax: self.state.absMaxCoolSetpointLimit,
    });
    self.state.absMinCoolSetpointLimit = cool.absMin;
    self.state.minCoolSetpointLimit = cool.min;
    self.state.maxCoolSetpointLimit = cool.max;
    self.state.absMaxCoolSetpointLimit = cool.absMax;

    const currentCooling = self.state.occupiedCoolingSetpoint;
    const coolingValue =
      typeof currentCooling === "number" && !Number.isNaN(currentCooling)
        ? currentCooling
        : 2400;
    self.state.occupiedCoolingSetpoint = coolingValue;
  } else {
    clearInactiveSetpointState(self, "Cool");
  }

  logger.debug(
    `initialize: after force-set - local=${self.state.localTemperature}`,
  );

  // Initialize thermostatRunningState (optional attribute) so controllers
  // subscribe to it from the start. This is the bitmap that indicates active
  // heating/cooling.
  self.state.thermostatRunningState = runningStateAllOff;

  // minSetpointDeadBand and thermostatRunningMode only exist with AutoMode. A
  // former AutoMode config can persist them onto a now non-AutoMode base, which
  // fails conformance on init like the setpoints do (code 135, #384).
  if (self.features.autoMode) {
    // Keep this inside the autoMode branch, writing the attribute on a base
    // without AutoMode crashes the endpoint ("Behaviors have errors"). The
    // assignment must stay "= 0", never "?? 0": the attribute is quality N
    // with a 2°C model default (20) that survives "??", and pre-super
    // initialize is the only window where the write sticks. HA has no such
    // gap between the heat and cool setpoints.
    self.state.minSetpointDeadBand = 0;
  } else {
    if (self.state.minSetpointDeadBand !== undefined)
      self.state.minSetpointDeadBand = undefined;
    if (self.state.thermostatRunningMode !== undefined)
      self.state.thermostatRunningMode = undefined;
  }

  // Set initial controlSequenceOfOperation based on enabled features.
  // CoolingAndHeating is only safe for AutoMode devices (HEAT+COOL+AUTO features).
  // Non-AutoMode devices with both features use HeatingOnly as safe initial value;
  // update() will set the correct dynamic value via internal override (#28).
  self.state.controlSequenceOfOperation =
    self.features.cooling && self.features.heating && self.features.autoMode
      ? Thermostat.ControlSequenceOfOperation.CoolingAndHeating
      : self.features.heating
        ? Thermostat.ControlSequenceOfOperation.HeatingOnly
        : Thermostat.ControlSequenceOfOperation.CoolingOnly;

  if (self.features?.presets) {
    self.state.presetTypes = self.state.presetTypes ?? standardPresetTypes;
    self.state.numberOfPresets = self.state.numberOfPresets ?? 10;
    self.state.activePresetHandle = self.state.activePresetHandle ?? null;

    if (
      !self.state.persistedPresets ||
      self.state.persistedPresets.length === 0
    ) {
      // First boot: seed standard presets WITHOUT clamping against raw un-converted limits.
      // update() immediately follows and clamps them against true converted limits.
      self.state.persistedPresets = createStandardPresets(
        self.features.heating,
        self.features.cooling,
      );
    } else {
      // Repair handles, builtIn flags, and active/inactive feature directions using
      // full Matter temperature bounds (-273.15°C..327.67°C); limit clamping happens
      // exclusively in update() once isAvailable is true so consecutive unavailable boots
      // on °F (or sub-zero) thermostats cannot clamp against raw limits.
      const matterTempMin = -27315;
      const matterTempMax = 32767;
      self.state.persistedPresets = self.state.persistedPresets.map(
        (preset: Thermostat.Preset) =>
          repairPreset(
            preset,
            self.features.heating,
            self.features.cooling,
            matterTempMin,
            matterTempMax,
            matterTempMin,
            matterTempMax,
          ),
      );
    }
  }
}

/**
 * Post-super initialization: load HA entity, run first update, wire up reactors.
 * Must run AFTER super.initialize() because agent/events aren't ready before.
 * Extracted as standalone function so each feature-variant class can call it
 * from its own initialize() with correct super binding.
 */
// biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
async function thermostatPostInitialize(self: any): Promise<void> {
  const homeAssistant = await self.agent.load(HomeAssistantEntityBehavior);
  const runtime = getRuntimeState(self, homeAssistant.entityId);
  runtime.lastPresetActivation = undefined;
  runtime.lastObservedSystemMode = undefined;
  runtime.prevPersistedPresets = undefined;
  self.update(homeAssistant.entity);

  self.reactTo(self.events.systemMode$Changing, self.systemModeChanging);
  self.reactTo(self.events.systemMode$Changed, self.systemModeChanged);
  // Use $Changing (pre-commit) for setpoint changes to avoid access control issues
  // The $Changed event fires in post-commit where we lose write permissions
  if (self.features.cooling) {
    self.reactTo(
      self.events.occupiedCoolingSetpoint$Changing,
      self.coolingSetpointChanging,
    );
  }
  if (self.features.heating) {
    self.reactTo(
      self.events.occupiedHeatingSetpoint$Changing,
      self.heatingSetpointChanging,
    );
  }
  if (self.features?.presets) {
    self.reactTo(
      self.events.persistedPresets$Changed,
      self.persistedPresetsChanged,
    );
    self.reactTo(
      self.events.temperatureSetpointHold$Changed,
      self.temperatureSetpointHoldChanged,
    );
    self.reactTo(
      self.events.temperatureSetpointHoldDuration$Changed,
      self.temperatureSetpointHoldDurationChanged,
    );
    const attr000EEvt = self.events.appleAttr000E$Changed;
    if (attr000EEvt) {
      self.reactTo(attr000EEvt, self.appleAttr000EChanged);
    }
    if (
      self.state.temperatureSetpointHold ===
        Thermostat.TemperatureSetpointHold.SetpointHoldOn &&
      typeof self.state.setpointHoldExpiryTimestamp === "number"
    ) {
      scheduleHoldExpiry(
        self,
        runtime,
        self.state.setpointHoldExpiryTimestamp * 1000,
      );
    }
    for (const attr of [
      "appleAttr0002",
      "appleAttr0010",
      "appleAttr0011",
      "appleAttr0012",
      "appleAttr0013",
    ]) {
      const evt = self.events[`${attr}$Changed`];
      if (evt) {
        self.reactTo(evt, (value: unknown) => {
          const formatted =
            value && typeof value === "object"
              ? JSON.stringify(value, (_, v) =>
                  Bytes.isBytes(v) ? `0x${Bytes.toHex(v)}` : v,
                )
              : String(value);
          logger.debug(`[APPLE-MEI] Write Thermostat.${attr} = ${formatted}`);
        });
      }
    }
  }
  self.reactTo(homeAssistant.onChange, self.update, { lock: true });
}

export function applyPresetSetpointsToState(
  // biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants and test mocks
  self: any,
  newHeat: number | undefined,
  newCool: number | undefined,
  tx?: object,
): void {
  const oldCool = self.state.occupiedCoolingSetpoint ?? 2400;
  const writeSetpoint = (kind: SetpointTrackedKind, nextVal: number) => {
    const attr =
      kind === "heat" ? "occupiedHeatingSetpoint" : "occupiedCoolingSetpoint";
    if (Object.is(self.state[attr], nextVal)) {
      return;
    }
    recordInternalWrite(internalSetpointWritesByTx, tx, kind, nextVal);
    self.state[attr] = nextVal;
  };

  if (
    self.features.heating &&
    self.features.cooling &&
    self.features.autoMode
  ) {
    if (newHeat !== undefined && newCool !== undefined) {
      if (newHeat > oldCool) {
        writeSetpoint("cool", newCool);
        writeSetpoint("heat", newHeat);
      } else {
        writeSetpoint("heat", newHeat);
        writeSetpoint("cool", newCool);
      }
    } else if (newHeat !== undefined) {
      writeSetpoint("heat", newHeat);
    } else if (newCool !== undefined) {
      writeSetpoint("cool", newCool);
    }
  } else {
    if (self.features.heating && newHeat !== undefined) {
      writeSetpoint("heat", newHeat);
    }
    if (self.features.cooling && newCool !== undefined) {
      writeSetpoint("cool", newCool);
    }
  }
}

export class ThermostatServerBase extends AdaptiveFullFeaturedBase {
  declare state: ThermostatServerBase.State;

  // State class only declares the config property type.
  // ALL defaults are set via .set() in the ThermostatServer function below
  // so matter.js's internal cluster data store picks them up before init.
  static override State = class State extends AdaptiveFullFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }

  override async [Symbol.asyncDispose]() {
    clearEndpointHoldTimers(this.endpoint);
    await super[Symbol.asyncDispose]();
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const runtime = getRuntimeState(this, homeAssistant.entityId);
    const config = this.state.config;

    // When unavailable, keep last known values but report offline via BasicInformation.reachable
    // Only update temperatures if entity is available to prevent null/invalid values
    const isAvailable = homeAssistant.isAvailable;

    const minSetpointLimit = isAvailable
      ? config.getMinTemperature(entity.state, this.agent)?.celsius(true)
      : this.features.heating
        ? this.state.minHeatSetpointLimit
        : this.state.minCoolSetpointLimit;
    const maxSetpointLimit = isAvailable
      ? config.getMaxTemperature(entity.state, this.agent)?.celsius(true)
      : this.features.heating
        ? this.state.maxHeatSetpointLimit
        : this.state.maxCoolSetpointLimit;
    const currentTemperature = isAvailable
      ? config.getCurrentTemperature(entity.state, this.agent)?.celsius(true)
      : this.state.localTemperature;
    const haHeatingTemperature =
      this.features.heating && isAvailable
        ? config
            .getTargetHeatingTemperature(entity.state, this.agent)
            ?.celsius(true)
        : undefined;
    const haCoolingTemperature =
      this.features.cooling && isAvailable
        ? config
            .getTargetCoolingTemperature(entity.state, this.agent)
            ?.celsius(true)
        : undefined;
    const targetHeatingTemperature = this.features.heating
      ? (haHeatingTemperature ?? this.state.occupiedHeatingSetpoint)
      : undefined;
    const targetCoolingTemperature = this.features.cooling
      ? (haCoolingTemperature ?? this.state.occupiedCoolingSetpoint)
      : undefined;
    // A stored setpoint read back while Off already carries the nudge.
    const wasOff = this.state.systemMode === Thermostat.SystemMode.Off;

    const systemMode = isAvailable
      ? this.getSystemMode(entity)
      : (this.state.systemMode ?? Thermostat.SystemMode.Off);
    const prevSystemMode = runtime.lastObservedSystemMode;
    const runningMode = isAvailable
      ? config.getRunningMode(entity.state, this.agent)
      : Thermostat.ThermostatRunningMode.Off;

    // Temperature limit handling:
    // Use HA's actual min/max limits for ALL modes (single and dual).
    // minSetpointDeadBand: 0 for full HVAC devices (no gap between heat/cool setpoints).
    // Fall back to wide limits (0-50°C) only when HA doesn't provide limits.
    const WIDE_MIN = 0; // 0°C
    const WIDE_MAX = 5000; // 50°C

    let minHeatLimit: number | undefined;
    let minCoolLimit: number | undefined;
    let maxHeatLimit: number | undefined;
    let maxCoolLimit: number | undefined;

    if (this.features.heating) {
      minHeatLimit = minSetpointLimit ?? WIDE_MIN;
      maxHeatLimit = maxSetpointLimit ?? WIDE_MAX;
      // Matter requires min <= max; HA can report them inverted (#375).
      if (minHeatLimit > maxHeatLimit) {
        [minHeatLimit, maxHeatLimit] = [maxHeatLimit, minHeatLimit];
      }
    }
    if (this.features.cooling) {
      minCoolLimit = minSetpointLimit ?? WIDE_MIN;
      maxCoolLimit = maxSetpointLimit ?? WIDE_MAX;
      if (minCoolLimit > maxCoolLimit) {
        [minCoolLimit, maxCoolLimit] = [maxCoolLimit, minCoolLimit];
      }
    }

    // Clamp setpoints to be within the calculated limits to prevent Matter.js validation errors
    // This handles cases where HA reports setpoints outside the valid range
    const clampedHeatingSetpoint = this.clampSetpoint(
      targetHeatingTemperature,
      minHeatLimit,
      maxHeatLimit,
      "heat",
    );
    const clampedCoolingSetpoint = this.clampSetpoint(
      targetCoolingTemperature,
      minCoolLimit,
      maxCoolLimit,
      "cool",
    );

    // Avoid controller 0 C or out-of-range fallback values (#470).
    const localTemperature =
      typeof currentTemperature === "number" &&
      !Number.isNaN(currentTemperature)
        ? currentTemperature
        : targetHeatingTemperature != null
          ? clampedHeatingSetpoint
          : targetCoolingTemperature != null
            ? clampedCoolingSetpoint
            : null;

    logger.debug(
      `update: limits heat=[${minHeatLimit}, ${maxHeatLimit}], cool=[${minCoolLimit}, ${maxCoolLimit}], systemMode=${systemMode}, runningMode=${runningMode}`,
    );

    // Compute controlSequenceOfOperation and update the internal value BEFORE
    // writing to state. Matter.js's ThermostatBaseServer stores this in
    // internal.controlSequenceOfOperation and has a $Changing reactor that
    // reverts any state write back to the internal value. We must update
    // internal first so the reactor allows our new value through. The
    // systemMode $Changing reactor also validates against the internal value.
    let controlSequence = config.getControlSequence(entity.state, this.agent);
    // Clamp controlSequenceOfOperation to match enabled features.
    // Config callbacks may return values incompatible with the thermostat's
    // actual feature set (e.g., HeatingOnly for a cooling-only AC with 'auto').
    controlSequence = this.clampControlSequence(controlSequence);
    // biome-ignore lint/suspicious/noExplicitAny: Access protected internal state from Matter.js base
    (this as any).internal.controlSequenceOfOperation = controlSequence;

    // Property order matters: applyPatchState sets properties sequentially, so if one
    // property write triggers an error, subsequent properties won't be set.
    // Limits are set FIRST to ensure they're applied even if mode changes trigger errors.
    applyPatchState(this.state, {
      // abs limits BEFORE user limits: on a widening update the user limit
      // must never transiently sit outside the still-narrow abs limit, the
      // reactor asserts against abs on every write (#454 hardening)
      ...(this.features.heating
        ? {
            absMinHeatSetpointLimit: minHeatLimit,
            absMaxHeatSetpointLimit: maxHeatLimit,
            minHeatSetpointLimit: minHeatLimit,
            maxHeatSetpointLimit: maxHeatLimit,
          }
        : {}),
      ...(this.features.cooling
        ? {
            absMinCoolSetpointLimit: minCoolLimit,
            absMaxCoolSetpointLimit: maxCoolLimit,
            minCoolSetpointLimit: minCoolLimit,
            maxCoolSetpointLimit: maxCoolLimit,
          }
        : {}),
      localTemperature: localTemperature,
      controlSequenceOfOperation: controlSequence,
      thermostatRunningState: this.getRunningState(systemMode, runningMode),
      systemMode: systemMode,
      // thermostatRunningMode: Only set for Auto mode. Matter.js's reactor handles
      // Heat/Cool/Off but SKIPS Auto (see #handleSystemModeChange in Matter.js).
      // Without this, switching Heat→Auto leaves runningMode stale at Heat.
      // 889010b set for ALL modes (conflicted with reactor), 0678d35 set for NONE
      // (stale in Auto). da04b2e's Auto-only approach is correct, the issues
      // reported after it were caused by localTemperature fallback, not runningMode.
      ...(this.features.heating &&
      this.features.cooling &&
      systemMode === Thermostat.SystemMode.Auto
        ? { thermostatRunningMode: runningMode }
        : {}),
    });

    // 2. Clamp persistedPresets SECOND (after limits are updated on this.state,
    // and only once HA reports an available state so raw °F bounds don't corrupt defaults).
    if (isAvailable && this.features.presets && this.state.persistedPresets) {
      this.reconcilePersistedPresets(
        minHeatLimit ?? WIDE_MIN,
        maxHeatLimit ?? WIDE_MAX,
        minCoolLimit ?? WIDE_MIN,
        maxCoolLimit ?? WIDE_MAX,
        runtime,
      );
    }

    // 3. Capture activePresetHandle before setpoint write.
    // Reconcile sets intendedActivePresetByTx for this transaction so pre-commit
    // $Changing handlers restore activePresetHandle after Matter.js's internal reset.
    const savedPresetHandle = this.features.presets
      ? this.state.activePresetHandle
      : null;

    // Setpoints are applied in a separate patch wrapped with the nudgingSetpoints
    // guard. When Off, setpoints are nudged by +1 centidegree (0.01°C) so any
    // controller write, even the "same" temperature, triggers $Changing for
    // auto-resume (#176). The guard prevents the nudge itself from auto-resuming.
    runtime.nudgingSetpoints = true;
    try {
      applyPatchState(this.state, {
        ...(this.features.heating
          ? {
              occupiedHeatingSetpoint:
                systemMode === Thermostat.SystemMode.Off &&
                (haHeatingTemperature != null ||
                  (!wasOff &&
                    runtime.nudgedHeat !==
                      this.state.occupiedHeatingSetpoint) ||
                  clampedHeatingSetpoint !== this.state.occupiedHeatingSetpoint)
                  ? nudgeSetpoint(
                      clampedHeatingSetpoint,
                      maxHeatLimit ?? WIDE_MAX,
                    )
                  : clampedHeatingSetpoint,
            }
          : {}),
        ...(this.features.cooling
          ? {
              occupiedCoolingSetpoint:
                systemMode === Thermostat.SystemMode.Off &&
                (haCoolingTemperature != null ||
                  (!wasOff &&
                    runtime.nudgedCool !==
                      this.state.occupiedCoolingSetpoint) ||
                  clampedCoolingSetpoint !== this.state.occupiedCoolingSetpoint)
                  ? nudgeSetpoint(
                      clampedCoolingSetpoint,
                      maxCoolLimit ?? WIDE_MAX,
                    )
                  : clampedCoolingSetpoint,
            }
          : {}),
      });
    } finally {
      runtime.nudgingSetpoints = false;
    }

    // 4. Reconcile activePresetHandle across HVAC mode switches & manual drift.
    if (this.features.presets && savedPresetHandle !== null) {
      this.reconcileActivePresetOnUpdate(savedPresetHandle, runtime, {
        entity,
        isAvailable,
        systemMode,
        prevSystemMode,
        haHeatingTemperature,
        haCoolingTemperature,
        minHeatLimit: minHeatLimit ?? WIDE_MIN,
        maxHeatLimit: maxHeatLimit ?? WIDE_MAX,
        minCoolLimit: minCoolLimit ?? WIDE_MIN,
        maxCoolLimit: maxCoolLimit ?? WIDE_MAX,
      });
    }
    runtime.lastObservedSystemMode = systemMode;
    if (this.features.heating) {
      this.trackNudge(
        runtime,
        "heat",
        systemMode,
        haHeatingTemperature,
        this.state.occupiedHeatingSetpoint,
      );
    }
    if (this.features.cooling) {
      this.trackNudge(
        runtime,
        "cool",
        systemMode,
        haCoolingTemperature,
        this.state.occupiedCoolingSetpoint,
      );
    }
  }

  private reconcilePersistedPresets(
    minHeat: number,
    maxHeat: number,
    minCool: number,
    maxCool: number,
    runtime: ThermostatRuntimeState,
  ): void {
    const presets = this.state.persistedPresets ?? [];
    let presetsChanged = false;
    const updatedPresets = presets.map((preset) => {
      let heat = preset.heatingSetpoint;
      let cool = preset.coolingSetpoint;
      let changed = false;

      if (this.features.heating && heat !== undefined) {
        const clampedHeat = Math.max(minHeat, Math.min(maxHeat, heat));
        if (clampedHeat !== heat) {
          heat = clampedHeat;
          changed = true;
        }
      }
      if (this.features.cooling && cool !== undefined) {
        const clampedCool = Math.max(minCool, Math.min(maxCool, cool));
        if (clampedCool !== cool) {
          cool = clampedCool;
          changed = true;
        }
      }

      if (changed) {
        presetsChanged = true;
        const updated: Thermostat.Preset = { ...preset };
        if (this.features.heating && heat !== undefined) {
          updated.heatingSetpoint = heat;
        }
        if (this.features.cooling && cool !== undefined) {
          updated.coolingSetpoint = cool;
        }
        return updated;
      }
      return preset;
    });

    if (presetsChanged) {
      this.agent.asLocalActor(() => {
        this.state.persistedPresets = updatedPresets;
      });
      runtime.prevPersistedPresets = clonePresets(updatedPresets);
    } else if (!runtime.prevPersistedPresets) {
      runtime.prevPersistedPresets = clonePresets(presets);
    }
  }

  private reconcileActivePresetOnUpdate(
    savedPresetHandle: Bytes,
    runtime: ThermostatRuntimeState,
    ctx: {
      entity: HomeAssistantEntityInformation;
      isAvailable: boolean;
      systemMode: SystemMode;
      prevSystemMode: SystemMode | undefined;
      haHeatingTemperature: number | undefined;
      haCoolingTemperature: number | undefined;
      minHeatLimit: number;
      maxHeatLimit: number;
      minCoolLimit: number;
      maxCoolLimit: number;
    },
  ): void {
    const config = this.state.config;
    const activePreset = this.state.persistedPresets?.find(
      (p) =>
        p.presetHandle !== null &&
        Bytes.areEqual(p.presetHandle, savedPresetHandle),
    );
    const supportsRange = config.supportsTemperatureRange(
      ctx.entity.state,
      this.agent,
    );
    // HA `auto` and `heat_cool`-only zones without Matter AutoMode compute
    // SystemMode dynamically from hvac_action; Heat<->Cool display flips there
    // are not user HVAC mode switches.
    const isDynamicActionMode =
      !this.features.autoMode &&
      (ctx.entity.state.state === "auto" ||
        ctx.entity.state.state === "heat_cool");
    const isTemperatureControlledMode =
      ctx.systemMode === Thermostat.SystemMode.Heat ||
      ctx.systemMode === Thermostat.SystemMode.EmergencyHeat ||
      ctx.systemMode === Thermostat.SystemMode.Cool ||
      ctx.systemMode === Thermostat.SystemMode.Precooling ||
      ctx.systemMode === Thermostat.SystemMode.Auto;
    const modeSwitchedToActive =
      ctx.isAvailable &&
      !isDynamicActionMode &&
      isTemperatureControlledMode &&
      activePreset != null &&
      ctx.prevSystemMode !== undefined &&
      ctx.prevSystemMode !== Thermostat.SystemMode.Off &&
      ctx.prevSystemMode !== ctx.systemMode;

    const key = txKey(this, ctx.entity.entity_id);
    if (modeSwitchedToActive && activePreset) {
      const newHeat =
        this.features.heating && activePreset.heatingSetpoint !== undefined
          ? Math.max(
              ctx.minHeatLimit,
              Math.min(ctx.maxHeatLimit, activePreset.heatingSetpoint),
            )
          : undefined;
      const newCool =
        this.features.cooling && activePreset.coolingSetpoint !== undefined
          ? Math.max(
              ctx.minCoolLimit,
              Math.min(ctx.maxCoolLimit, activePreset.coolingSetpoint),
            )
          : undefined;
      runtime.activatingPreset = true;
      try {
        applyPresetSetpointsToState(this, newHeat, newCool);
      } finally {
        runtime.activatingPreset = false;
      }
      logger.debug(
        `[APPLE-MEI] Mode switch ${ctx.prevSystemMode}->${ctx.systemMode} with active preset 0x${Bytes.toHex(savedPresetHandle)}: applying heat=${newHeat}, cool=${newCool}`,
      );
      runtime.lastPresetActivation = {
        handle: savedPresetHandle,
        at: Date.now(),
      };
      setIntendedPresetForTx(this.context?.transaction, key, savedPresetHandle);
      this.state.activePresetHandle = savedPresetHandle;
      this.agent.asLocalActor(() => {
        const heatTemp = Temperature.celsius(
          (this.state.occupiedHeatingSetpoint ?? 2000) / 100,
        )!;
        const coolTemp = Temperature.celsius(
          (this.state.occupiedCoolingSetpoint ?? 2400) / 100,
        )!;
        const mode = targetModeForActiveSystemMode(
          ctx.systemMode,
          this.features.heating,
          this.features.cooling,
        );
        this.setTemperature(heatTemp, coolTemp, mode);
      });
      return;
    }

    const lastActivation = runtime.lastPresetActivation;
    const isWithinEchoWindow =
      lastActivation?.handle != null &&
      Date.now() - lastActivation.at <= PRESET_ECHO_WINDOW_MS;

    // Preserve activePresetHandle when Off, inside the echo window, or while
    // active-mode setpoints still match the latched preset within ±0.6°C.
    let setpointsMatchWithinTolerance = false;
    if (activePreset != null) {
      let heatMatches = true;
      let coolMatches = true;
      if (this.features.heating && activePreset.heatingSetpoint !== undefined) {
        const currentHeat =
          ctx.haHeatingTemperature ?? this.state.occupiedHeatingSetpoint;
        heatMatches =
          Math.abs(currentHeat - activePreset.heatingSetpoint) <=
          SETPOINT_MATCH_TOLERANCE_CENTIDEGREES;
      }
      if (this.features.cooling && activePreset.coolingSetpoint !== undefined) {
        const currentCool =
          ctx.haCoolingTemperature ?? this.state.occupiedCoolingSetpoint;
        coolMatches =
          Math.abs(currentCool - activePreset.coolingSetpoint) <=
          SETPOINT_MATCH_TOLERANCE_CENTIDEGREES;
      }

      const requiresHeat =
        supportsRange ||
        ctx.systemMode === Thermostat.SystemMode.Heat ||
        ctx.systemMode === Thermostat.SystemMode.EmergencyHeat ||
        !this.features.cooling;
      const requiresCool =
        supportsRange ||
        ctx.systemMode === Thermostat.SystemMode.Cool ||
        ctx.systemMode === Thermostat.SystemMode.Precooling ||
        !this.features.heating;

      setpointsMatchWithinTolerance =
        (!requiresHeat || heatMatches) && (!requiresCool || coolMatches);
    }

    const keepActive =
      isWithinEchoWindow ||
      setpointsMatchWithinTolerance ||
      ctx.systemMode === Thermostat.SystemMode.Off;

    const finalHandle = keepActive ? savedPresetHandle : null;
    setIntendedPresetForTx(this.context?.transaction, key, finalHandle);
    if (!keepActive) {
      logger.debug(
        `[APPLE-MEI] Entering Apple hold from active preset 0x${Bytes.toHex(savedPresetHandle)} -> null (systemMode=${ctx.systemMode}, heat=${ctx.haHeatingTemperature}, cool=${ctx.haCoolingTemperature})`,
      );
      enterAppleHold(this.state, runtime, {
        source: Thermostat.SetpointChangeSource.Manual,
        amount: null,
        scheduledPresetHandle: savedPresetHandle,
      });
    }
    this.state.activePresetHandle = finalHandle;
  }

  private trackNudge(
    runtime: ThermostatRuntimeState,
    kind: "heat" | "cool",
    systemMode: SystemMode,
    haTemperature: number | undefined,
    setpoint: number,
  ) {
    if (systemMode === SystemMode.Off) {
      if (kind === "heat") runtime.nudgedHeat = setpoint;
      else runtime.nudgedCool = setpoint;
    } else if (haTemperature != null) {
      if (kind === "heat") runtime.nudgedHeat = undefined;
      else runtime.nudgedCool = undefined;
    }
  }

  override setActivePresetRequest(request: Thermostat.SetActivePresetRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const runtime = getRuntimeState(this, homeAssistant.entityId);
    const config = this.state.config;
    const tx = this.context?.transaction;

    if (!tx) {
      runtime.activatingPreset = true;
    }
    try {
      const wasOff = this.state.systemMode === Thermostat.SystemMode.Off;
      const preset = (
        this as unknown as {
          handleSetActivePresetRequest(
            req: Thermostat.SetActivePresetRequest,
          ): Thermostat.Preset | undefined;
        }
      ).handleSetActivePresetRequest(request);

      if (request.presetHandle === null) {
        runtime.lastPresetActivation = { handle: null, at: Date.now() };
        if (tx) {
          setIntendedPresetForTx(tx, txKey(this, homeAssistant.entityId), null);
        }
        this.state.activePresetHandle = null;
        clearApplePresetTracking(this.state, runtime, tx);
        return;
      }

      if (!preset) {
        return;
      }

      homeAssistant.assertAvailable?.();

      const minHeat = this.state.minHeatSetpointLimit ?? 0;
      const maxHeat = this.state.maxHeatSetpointLimit ?? 5000;
      const minCool = this.state.minCoolSetpointLimit ?? 0;
      const maxCool = this.state.maxCoolSetpointLimit ?? 5000;

      const newHeat =
        preset.heatingSetpoint !== undefined
          ? Math.max(minHeat, Math.min(maxHeat, preset.heatingSetpoint))
          : undefined;
      const newCool =
        preset.coolingSetpoint !== undefined
          ? Math.max(minCool, Math.min(maxCool, preset.coolingSetpoint))
          : undefined;

      if (tx) {
        setIntendedPresetForTx(
          tx,
          txKey(this, homeAssistant.entityId),
          request.presetHandle,
        );
      }
      applyPresetSetpointsToState(this, newHeat, newCool, tx);

      this.state.activePresetHandle = request.presetHandle;
      const meiState = this.state as unknown as Record<string, unknown>;
      if (meiState.appleAttr0009 !== undefined) {
        meiState.appleAttr0009 = cloneBytes(request.presetHandle);
      }
      if (meiState.appleAttr000B !== undefined) {
        meiState.appleAttr000B = null;
      }
      clearHoldState(this.state, runtime, { tx });
      if (meiState.appleAttr000F !== undefined) {
        meiState.appleAttr000F = preset.presetScenario;
      }
      if (this.state.setpointChangeSource !== undefined) {
        this.state.setpointChangeSource =
          Thermostat.SetpointChangeSource.External;
        this.state.setpointChangeAmount = null;
        this.state.setpointChangeSourceTimestamp = nowEpochS();
      }
      runtime.lastPresetActivation = {
        handle: request.presetHandle,
        at: Date.now(),
      };

      this.agent.asLocalActor(() => {
        let resumed: Thermostat.SystemMode | undefined;
        const supportsRange = config.supportsTemperatureRange(
          homeAssistant.entity.state,
          this.agent,
        );
        if (wasOff && !supportsRange) {
          const localTemp = this.state.localTemperature;
          const preferred = !this.features.heating
            ? Thermostat.SystemMode.Cool
            : this.features.cooling &&
                newCool !== undefined &&
                typeof localTemp === "number" &&
                localTemp > newCool
              ? Thermostat.SystemMode.Cool
              : Thermostat.SystemMode.Heat;
          resumed = this.autoResumeFromOff(preferred, "setActivePresetRequest");
        }

        const heatTemp = Temperature.celsius(
          (this.state.occupiedHeatingSetpoint ?? 2000) / 100,
        )!;
        const coolTemp = Temperature.celsius(
          (this.state.occupiedCoolingSetpoint ?? 2400) / 100,
        )!;
        const effectiveSystemMode = resumed ?? this.state.systemMode;
        const mode = targetModeForActiveSystemMode(
          effectiveSystemMode,
          this.features.heating,
          this.features.cooling,
        );
        this.setTemperature(heatTemp, coolTemp, mode, resumed);
      });
    } finally {
      if (!tx) {
        runtime.activatingPreset = false;
      }
    }
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private persistedPresetsChanged(
    newPresets: Thermostat.Preset[],
    oldPresets: Thermostat.Preset[],
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    logger.debug(
      `[APPLE-MEI] Presets committed via AtomicRequest: ${JSON.stringify(
        newPresets.map((p) => ({
          handle: p.presetHandle ? `0x${Bytes.toHex(p.presetHandle)}` : null,
          scenario: p.presetScenario,
          heat: p.heatingSetpoint,
          cool: p.coolingSetpoint,
        })),
      )}`,
    );
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const runtime = getRuntimeState(this, homeAssistant.entityId);
      const config = this.state.config;

      const prev = runtime.prevPersistedPresets ?? oldPresets;
      runtime.prevPersistedPresets = clonePresets(newPresets);

      const activeHandle = this.state.activePresetHandle;
      if (activeHandle !== null) {
        const activePreset = newPresets.find(
          (p) =>
            p.presetHandle !== null &&
            Bytes.areEqual(p.presetHandle, activeHandle),
        );
        const prevPreset = prev?.find(
          (p) =>
            p.presetHandle !== null &&
            Bytes.areEqual(p.presetHandle, activeHandle),
        );
        if (activePreset) {
          const heatChanged =
            this.features.heating &&
            activePreset.heatingSetpoint !== undefined &&
            activePreset.heatingSetpoint !== prevPreset?.heatingSetpoint;
          const coolChanged =
            this.features.cooling &&
            activePreset.coolingSetpoint !== undefined &&
            activePreset.coolingSetpoint !== prevPreset?.coolingSetpoint;
          if (heatChanged || coolChanged) {
            const savedHandle = this.state.activePresetHandle;
            const key = txKey(this, homeAssistant.entityId);
            const tx = this.context?.transaction;
            if (tx) {
              setIntendedPresetForTx(tx, key, savedHandle);
            }
            applyPresetSetpointsToState(
              this,
              this.features.heating ? activePreset.heatingSetpoint : undefined,
              this.features.cooling ? activePreset.coolingSetpoint : undefined,
              tx,
            );
            this.state.activePresetHandle = savedHandle;
            runtime.lastPresetActivation = {
              handle: savedHandle,
              at: Date.now(),
            };

            const supportsRange =
              config.supportsTemperatureRange?.(
                homeAssistant.entity.state,
                this.agent,
              ) ?? false;
            const sysMode = this.state.systemMode;
            const activeDirectionChanged =
              sysMode === Thermostat.SystemMode.Off
                ? false
                : supportsRange ||
                    sysMode == null ||
                    sysMode === Thermostat.SystemMode.Auto
                  ? heatChanged || coolChanged
                  : sysMode === Thermostat.SystemMode.Dry ||
                      sysMode === Thermostat.SystemMode.FanOnly
                    ? this.features.cooling
                      ? coolChanged
                      : heatChanged
                    : sysMode === Thermostat.SystemMode.Heat ||
                        sysMode === Thermostat.SystemMode.EmergencyHeat
                      ? heatChanged
                      : sysMode === Thermostat.SystemMode.Cool ||
                          sysMode === Thermostat.SystemMode.Precooling
                        ? coolChanged
                        : heatChanged || coolChanged;

            if (activeDirectionChanged) {
              const heatTemp = Temperature.celsius(
                (this.state.occupiedHeatingSetpoint ?? 2000) / 100,
              )!;
              const coolTemp = Temperature.celsius(
                (this.state.occupiedCoolingSetpoint ?? 2400) / 100,
              )!;
              const mode = targetModeForActiveSystemMode(
                this.state.systemMode,
                this.features.heating,
                this.features.cooling,
              );
              this.setTemperature(heatTemp, coolTemp, mode);
            }
          }
        }
      }
    });
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private temperatureSetpointHoldChanged(
    value: Thermostat.TemperatureSetpointHold,
    _oldValue: Thermostat.TemperatureSetpointHold,
    context?: ActionContext,
  ) {
    const tx = context?.transaction ?? this.context?.transaction;
    if (
      transactionIsOffline(context) ||
      consumeInternalWrite(
        internalHoldWritesByTx,
        tx,
        "temperatureSetpointHold",
        value,
      )
    ) {
      return;
    }
    logger.debug(
      `[APPLE-MEI] Write Thermostat.temperatureSetpointHold = ${value}`,
    );
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const runtime = getRuntimeState(this, homeAssistant.entityId);
      const meiState = this.state as unknown as Record<string, unknown>;

      if (value === Thermostat.TemperatureSetpointHold.SetpointHoldOff) {
        clearHoldState(this.state, runtime, { tx });
        if (
          !isAdaptiveTemperatureEnabled(this.state) ||
          !Bytes.isBytes(meiState.appleAttr0009)
        ) {
          return;
        }
        const expectedGen = runtime.holdGeneration;
        const endpoint = this.endpoint;
        const behaviorType = (
          this as unknown as { type?: Parameters<Agent["get"]>[0] }
        ).type;
        if (endpoint && typeof endpoint.act === "function" && behaviorType) {
          runtime.holdTimer = setTimeout(() => {
            runtime.holdTimer = undefined;
            if (
              runtime.holdGeneration !== expectedGen ||
              !endpoint.lifecycle?.isReady ||
              endpoint.lifecycle?.isGone
            ) {
              return;
            }
            void Promise.resolve(
              endpoint.act(async (agent) => {
                if (
                  runtime.holdGeneration !== expectedGen ||
                  endpoint.lifecycle?.isGone
                ) {
                  return;
                }
                // biome-ignore lint/suspicious/noExplicitAny: Internal helper working across feature variants
                const behavior = agent.get(behaviorType) as any;
                if (typeof agent.context?.transaction?.lock === "function") {
                  await agent.context.transaction.lock(behavior);
                }
                if (
                  runtime.holdGeneration !== expectedGen ||
                  endpoint.lifecycle?.isGone
                ) {
                  return;
                }
                if (
                  behavior.state.temperatureSetpointHold !==
                    Thermostat.TemperatureSetpointHold.SetpointHoldOff ||
                  behavior.state.activePresetHandle !== null
                ) {
                  return;
                }
                resumeScheduledPresetOrClearHold(behavior, runtime);
              }),
            ).catch((err: unknown) => {
              logger.warn(
                "[APPLE-MEI] Failed to resume preset after End Hold:",
                err,
              );
            });
          }, 0);
          runtime.holdTimer.unref?.();
        } else {
          resumeScheduledPresetOrClearHold(this, runtime);
        }
        return;
      }

      if (value === Thermostat.TemperatureSetpointHold.SetpointHoldOn) {
        const durationMinutes =
          this.state.temperatureSetpointHoldDuration &&
          this.state.temperatureSetpointHoldDuration > 0
            ? this.state.temperatureSetpointHoldDuration
            : undefined;
        const adaptiveEnabled = isAdaptiveTemperatureEnabled(this.state);
        applyHoldDuration(this, runtime, {
          durationMinutes,
          resumeOnNextEvent:
            adaptiveEnabled && durationMinutes !== undefined
              ? false
              : undefined,
          updateAppleMei: adaptiveEnabled,
          tx,
        });
      }
    });
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private temperatureSetpointHoldDurationChanged(
    value: number | null,
    _oldValue: number | null,
    context?: ActionContext,
  ) {
    const tx = context?.transaction ?? this.context?.transaction;
    if (
      transactionIsOffline(context) ||
      consumeInternalWrite(
        internalHoldWritesByTx,
        tx,
        "temperatureSetpointHoldDuration",
        value,
      )
    ) {
      return;
    }
    logger.debug(
      `[APPLE-MEI] Write Thermostat.temperatureSetpointHoldDuration = ${value}`,
    );
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const runtime = getRuntimeState(this, homeAssistant.entityId);
      const adaptiveEnabled = isAdaptiveTemperatureEnabled(this.state);

      if (value != null && value > 0) {
        applyHoldDuration(this, runtime, {
          durationMinutes: value,
          resumeOnNextEvent: adaptiveEnabled ? false : undefined,
          setHoldOn: true,
          updateAppleMei: adaptiveEnabled,
          tx,
        });
      } else if (
        this.state.temperatureSetpointHold ===
        Thermostat.TemperatureSetpointHold.SetpointHoldOn
      ) {
        clearHoldTimer(runtime);
        if (this.state.setpointHoldExpiryTimestamp !== undefined) {
          this.state.setpointHoldExpiryTimestamp = null;
        }
      }
    });
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private appleAttr000EChanged(
    value: boolean,
    _oldValue: boolean,
    context?: ActionContext,
  ) {
    const tx = context?.transaction ?? this.context?.transaction;
    if (
      transactionIsOffline(context) ||
      consumeInternalWrite(internalHoldWritesByTx, tx, "appleAttr000E", value)
    ) {
      return;
    }
    logger.debug(`[APPLE-MEI] Write Thermostat.appleAttr000E = ${value}`);
    if (
      value === true &&
      this.state.temperatureSetpointHold ===
        Thermostat.TemperatureSetpointHold.SetpointHoldOn
    ) {
      this.agent.asLocalActor(() => {
        const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
        const runtime = getRuntimeState(this, homeAssistant.entityId);
        clearHoldState(this.state, runtime, {
          clearAppleOverride: false,
          setHoldOff: false,
          tx,
        });
      });
    }
  }

  applyAppleSetpointHold(
    resumeOnNextEvent: boolean,
    durationMinutes: number | null,
  ): void {
    if (!this.features.presets || !isAdaptiveTemperatureEnabled(this.state)) {
      return;
    }
    const tx = this.context?.transaction;
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const runtime = getRuntimeState(this, homeAssistant.entityId);
      applyHoldDuration(this, runtime, {
        durationMinutes: resumeOnNextEvent ? null : durationMinutes,
        resumeOnNextEvent,
        setHoldOn: true,
        updateAppleMei: true,
        tx,
      });
    });
  }

  override setpointRaiseLower(request: Thermostat.SetpointRaiseLowerRequest) {
    const config = this.state.config;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const state = homeAssistant.entity.state;

    let cool = config.getTargetCoolingTemperature(state, this.agent);
    let heat = config.getTargetHeatingTemperature(state, this.agent);

    if (!heat && !cool) {
      return;
    }
    homeAssistant.assertAvailable();
    // HA can sit outside the limits the controller saw (4 vs min 10).
    heat = this.clampToLimits(
      (heat ?? cool)!,
      this.state.minHeatSetpointLimit ?? this.state.minCoolSetpointLimit,
      this.state.maxHeatSetpointLimit ?? this.state.maxCoolSetpointLimit,
      "heat",
    );
    cool = this.clampToLimits(
      (cool ?? heat)!,
      this.state.minCoolSetpointLimit ?? this.state.minHeatSetpointLimit,
      this.state.maxCoolSetpointLimit ?? this.state.maxHeatSetpointLimit,
      "cool",
    );

    if (this.features.presets) {
      const tx = this.context?.transaction;
      this.agent.asLocalActor(() => {
        const runtime = getRuntimeState(this, homeAssistant.entityId);
        runtime.lastPresetActivation = { handle: null, at: Date.now() };
        enterAppleHold(this.state, runtime, {
          source: Thermostat.SetpointChangeSource.External,
          amount: request.amount * 10,
          tx,
        });
        this.state.activePresetHandle = null;
      });
    }

    let resumed: SystemMode | undefined;
    if (
      this.state.systemMode === SystemMode.Off &&
      !config.supportsTemperatureRange(state, this.agent)
    ) {
      this.agent.asLocalActor(() => {
        resumed = this.autoResumeFromOff(
          request.mode === Thermostat.SetpointRaiseLowerMode.Cool
            ? SystemMode.Cool
            : SystemMode.Heat,
          "setpointRaiseLower",
        );
      });
    }

    // Matter spec: amount is in 0.1°C steps (tenths of a degree).
    // Divide by 10 to convert to °C for the Temperature.plus() method.
    let adjustedCool =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Heat
        ? this.clampToLimits(
            cool.plus(request.amount / 10, "°C"),
            this.state.minCoolSetpointLimit ?? this.state.minHeatSetpointLimit,
            this.state.maxCoolSetpointLimit ?? this.state.maxHeatSetpointLimit,
            "cool",
          )
        : cool;
    let adjustedHeat =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Cool
        ? this.clampToLimits(
            heat.plus(request.amount / 10, "°C"),
            this.state.minHeatSetpointLimit ?? this.state.minCoolSetpointLimit,
            this.state.maxHeatSetpointLimit ?? this.state.maxCoolSetpointLimit,
            "heat",
          )
        : heat;
    // HA rejects a range with low above high, the moved setpoint drags the other
    if (adjustedHeat.celsius() > adjustedCool.celsius()) {
      if (request.mode === Thermostat.SetpointRaiseLowerMode.Heat) {
        adjustedCool = adjustedHeat;
      } else if (request.mode === Thermostat.SetpointRaiseLowerMode.Cool) {
        adjustedHeat = adjustedCool;
      }
    }
    this.setTemperature(adjustedHeat, adjustedCool, request.mode, resumed);
  }

  private clampToLimits(
    value: Temperature,
    min: number | undefined,
    max: number | undefined,
    kind: "heat" | "cool",
  ): Temperature {
    return Temperature.celsius(
      this.clampSetpoint(value.celsius(true), min, max, kind) / 100,
    )!;
  }

  private restoreIntendedPreset(context?: ActionContext) {
    const tx = context?.transaction;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const key = txKey(this, homeAssistant.entityId);
    const intended = getIntendedPresetForTx(tx, key);
    if (intended !== undefined) {
      this.state.activePresetHandle = intended;
    }
  }

  // Pre-commit handlers: $Changing instead of $Changed keeps write permission
  // for the Home Assistant action.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private heatingSetpointChanging(
    value: number,
    oldValue: number,
    context?: ActionContext,
  ) {
    this.setpointChanging("heat", value, oldValue, context);
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private coolingSetpointChanging(
    value: number,
    oldValue: number,
    context?: ActionContext,
  ) {
    this.setpointChanging("cool", value, oldValue, context);
  }

  private setpointChanging(
    kind: "heat" | "cool",
    value: number,
    oldValue: number,
    context?: ActionContext,
  ) {
    const heat = kind === "heat";
    const source = heat ? "heatingSetpointChanging" : "coolingSetpointChanging";
    logger.debug(
      `${source}: value=${value}, oldValue=${oldValue}, isOffline=${transactionIsOffline(context)}`,
    );
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const runtime = getRuntimeState(this, homeAssistant.entityId);
    const tx = context?.transaction;
    const internalPresetWrite = consumeInternalWrite(
      internalSetpointWritesByTx,
      tx ?? this.context?.transaction,
      kind,
      value,
    );
    if (
      transactionIsOffline(context) ||
      internalPresetWrite ||
      runtime.activatingPreset
    ) {
      if (this.features.presets) {
        this.restoreIntendedPreset(context);
      }
      return;
    }
    const next = Temperature.celsius(value / 100);
    if (!next) {
      return;
    }
    const amount = value - oldValue;
    // Use asLocalActor to avoid access control issues when accessing HomeAssistantEntityBehavior
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      const config = this.state.config;
      const supportsRange = config.supportsTemperatureRange(
        homeAssistant.entity.state,
        this.agent,
      );

      let resumed: SystemMode | undefined;
      // For single-temperature thermostats, determine if this setpoint should update HA.
      // We check the ACTUAL HA hvac_mode to handle auto mode correctly.
      if (!supportsRange) {
        const currentMode = this.state.systemMode;
        const haHvacMode = homeAssistant.entity.state.state;
        const isAutoMode = haHvacMode === "auto" || haHvacMode === "heat_cool";
        const isOwnMode = heat
          ? currentMode === SystemMode.Heat ||
            currentMode === SystemMode.EmergencyHeat
          : currentMode === SystemMode.Cool ||
            currentMode === SystemMode.Precooling;
        // Dry and FanOnly have no direction: one handler owns the single
        // temperature, so a write of both setpoints still calls HA once.
        const ownsDirectionless =
          (currentMode === SystemMode.Dry ||
            currentMode === SystemMode.FanOnly) &&
          heat === !this.features.cooling;
        const isOff = currentMode === SystemMode.Off;

        if (isOff && (heat ? this.features.heating : this.features.cooling)) {
          // Auto-resume (#176, #519): controller wrote a setpoint while Off.
          // #519: cooling writes on heat+cool devices used to be dropped.
          // The nudge in update() ensures $Changing fires even for same-value writes.
          // Skip if this $Changing was caused by the nudge itself (not a controller write).
          if (runtime.nudgingSetpoints) {
            logger.debug(
              `${source}: skipping auto-resume - nudge write in progress`,
            );
            return;
          }
          resumed = this.autoResumeFromOff(
            heat ? SystemMode.Heat : SystemMode.Cool,
            source,
          );
          // Proceed to forward the temperature to HA below.
        } else if (!isAutoMode && !isOwnMode && !ownsDirectionless) {
          // Auto mode: both setpoints update temperature (#71). Otherwise the
          // handler of the active direction forwards it.
          logger.debug(
            `${source}: skipping - not in own/auto mode (mode=${currentMode}, haMode=${haHvacMode})`,
          );
          if (this.features.presets) {
            runtime.lastPresetActivation = { handle: null, at: Date.now() };
            enterAppleHold(this.state, runtime, {
              source: Thermostat.SetpointChangeSource.External,
              amount,
              tx: tx ?? this.context?.transaction,
            });
            if (this.state.activePresetHandle !== null) {
              this.state.activePresetHandle = null;
            }
          }
          return;
        }
      }

      if (this.features.presets) {
        runtime.lastPresetActivation = { handle: null, at: Date.now() };
        enterAppleHold(this.state, runtime, {
          source: Thermostat.SetpointChangeSource.External,
          amount,
          tx: tx ?? this.context?.transaction,
        });
      }

      if (heat) {
        const coolingSetpoint = this.features.cooling
          ? this.state.occupiedCoolingSetpoint
          : value;
        this.setTemperature(
          next,
          Temperature.celsius(coolingSetpoint / 100)!,
          Thermostat.SetpointRaiseLowerMode.Heat,
          resumed,
        );
      } else {
        const heatingSetpoint = this.features.heating
          ? this.state.occupiedHeatingSetpoint
          : value;
        this.setTemperature(
          Temperature.celsius(heatingSetpoint / 100)!,
          next,
          Thermostat.SetpointRaiseLowerMode.Cool,
          resumed,
        );
      }
    });
  }

  private setTemperature(
    low: Temperature,
    high: Temperature,
    mode: Thermostat.SetpointRaiseLowerMode,
    resumed?: SystemMode,
  ) {
    const config = this.state.config;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);

    const supportsTemperatureRange = config.supportsTemperatureRange(
      homeAssistant.entity.state,
      this.agent,
    );

    let action: HomeAssistantAction;
    if (supportsTemperatureRange) {
      action = config.setTargetTemperatureRange({ low, high }, this.agent);
    } else {
      const both = mode === Thermostat.SetpointRaiseLowerMode.Heat ? low : high;
      // Range mode never auto-resumes: isTemperatureRangeActive needs a non-Off HA mode.
      action = config.setTargetTemperature(both, this.agent, resumed);
    }
    homeAssistant.callAction(action);
  }

  // Auto-resume from Off (#176, #519): send the mode to HA and optimistically
  // set systemMode so controllers stop reading Off until HA confirms (Alexa
  // answers "not responding" whenever systemMode reads Off). The state write
  // also makes the sibling setpoint handler see a non-Off mode within the same
  // transaction, so writing both setpoints at once resumes exactly once: the
  // first attribute in the write picks the mode (intent is ambiguous while
  // Off, so first-wins is the pinned rule, asserted in the #519 bringup test).
  private autoResumeFromOff(preferred: SystemMode, source: string): SystemMode {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const runtime = getRuntimeState(this, homeAssistant.entityId);
    const resumeMode = this.resumeModeFor(preferred);
    logger.info(
      `${source}: auto-resume - switching to ${SystemMode[resumeMode]} (was Off)`,
    );
    // State write first: if it throws, no HA side effect happened yet.
    this.state.systemMode = resumeMode;
    runtime.autoResuming = {
      mode: resumeMode,
      at: Date.now(),
    };
    homeAssistant.callAction(
      this.state.config.setSystemMode(resumeMode, this.agent),
    );
    return resumeMode;
  }

  // Flip to the sibling mode when controlSequenceOfOperation forbids the
  // preferred one; matter.js asserts the same table on systemMode$Changing.
  private resumeModeFor(preferred: SystemMode): SystemMode {
    // biome-ignore lint/suspicious/noExplicitAny: Access protected internal state from Matter.js base
    const cso = (this as any).internal.controlSequenceOfOperation;
    const Cso = Thermostat.ControlSequenceOfOperation;
    if (
      preferred === SystemMode.Heat &&
      (cso === Cso.CoolingOnly || cso === Cso.CoolingAndHeatingWithReheat)
    ) {
      return SystemMode.Cool;
    }
    if (
      preferred === SystemMode.Cool &&
      (cso === Cso.HeatingOnly || cso === Cso.HeatingWithReheat)
    ) {
      return SystemMode.Heat;
    }
    return preferred;
  }

  // climateBlockOff (#527): refuse Off from controllers. Off is an optional
  // SystemMode value, so ConstraintError is the spec answer. Apple's Matter
  // framework drops its expected Off on a failed write; after an accepted one
  // it filters our reports until that expected value times out.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private systemModeChanging(
    systemMode: Thermostat.SystemMode,
    _oldValue: Thermostat.SystemMode,
    context?: ActionContext,
  ) {
    if (
      transactionIsOffline(context) ||
      (systemMode !== SystemMode.Off && systemMode !== SystemMode.Sleep)
    ) {
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (homeAssistant.state.mapping?.climateBlockOff === true) {
      throw new StatusResponseError(
        `${SystemMode[systemMode]} is blocked for this thermostat (climateBlockOff)`,
        StatusCode.ConstraintError,
      );
    }
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via thermostatPostInitialize + prototype copy
  private systemModeChanged(
    systemMode: Thermostat.SystemMode,
    _oldValue: Thermostat.SystemMode,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    // Use asLocalActor to avoid access control issues when accessing HomeAssistantEntityBehavior
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      // Always consume a pending auto-resume entry; skip only on a match so a
      // stale entry can never swallow a different mode change (#519).
      const runtime = getRuntimeState(this, homeAssistant.entityId);
      const expected = runtime.autoResuming;
      runtime.autoResuming = undefined;
      if (
        expected?.mode === systemMode &&
        Date.now() - expected.at < AUTO_RESUME_MS
      ) {
        // The setpoint auto-resume already sent this mode to HA.
        return;
      }
      const action = this.state.config.setSystemMode(systemMode, this.agent);
      homeAssistant.callAction(action);
    });
  }

  private getSystemMode(entity: HomeAssistantEntityInformation) {
    // Clamp to the active features so a heat/cool flip can't put Heat on a
    // cooling-only base (or Auto without AutoMode) and crash init (#319, #381).
    return this.clampSystemMode(
      this.state.config.getSystemMode(entity.state, this.agent),
    );
  }

  private clampSystemMode(value: SystemMode): SystemMode {
    const { heating, cooling, autoMode } = this.features;
    if (
      (value === SystemMode.Heat || value === SystemMode.EmergencyHeat) &&
      !heating
    ) {
      return cooling ? SystemMode.Cool : SystemMode.Off;
    }
    if (
      (value === SystemMode.Cool || value === SystemMode.Precooling) &&
      !cooling
    ) {
      return heating ? SystemMode.Heat : SystemMode.Off;
    }
    if (value === SystemMode.Auto && !autoMode) {
      return cooling
        ? SystemMode.Cool
        : heating
          ? SystemMode.Heat
          : SystemMode.Off;
    }
    return value;
  }

  private getRunningState(
    systemMode: SystemMode,
    runningMode: RunningMode,
  ): ThermostatRunningState {
    const allOff: ThermostatRunningState = {
      cool: false,
      fan: false,
      heat: false,
      heatStage2: false,
      coolStage2: false,
      fanStage2: false,
      fanStage3: false,
    };
    const heat = { ...allOff, heat: true };
    const cool = { ...allOff, cool: true };
    const dry = { ...allOff, heat: true, fan: true };
    const fanOnly = { ...allOff, fan: true };

    // runningMode (derived from hvac_action) is the primary signal for
    // active heating/cooling, Apple Home reads it to distinguish
    // "Heating to 26" (active) from "Heat to 26" (mode selected, idle).
    // FanOnly/Dry have no RunningMode equivalent, so we fall back to systemMode.
    switch (runningMode) {
      case RunningMode.Heat:
        return heat;
      case RunningMode.Cool:
        return cool;
      case RunningMode.Off:
        // Not actively heating/cooling. For FanOnly/Dry, still indicate activity
        // based on systemMode since these modes have no RunningMode equivalent.
        switch (systemMode) {
          case SystemMode.FanOnly:
            return fanOnly;
          case SystemMode.Dry:
            return dry;
          default:
            return allOff;
        }
      default:
        // Future matter.js RunningMode values (e.g. alternative heat/cool)
        // fall through to "nothing running" rather than emitting undefined.
        return allOff;
    }
  }

  private clampControlSequence(
    value: Thermostat.ControlSequenceOfOperation,
  ): Thermostat.ControlSequenceOfOperation {
    const hasHeat = this.features.heating;
    const hasCool = this.features.cooling;
    const needsHeat =
      value === Thermostat.ControlSequenceOfOperation.HeatingOnly ||
      value === Thermostat.ControlSequenceOfOperation.HeatingWithReheat;
    const needsCool =
      value === Thermostat.ControlSequenceOfOperation.CoolingOnly ||
      value === Thermostat.ControlSequenceOfOperation.CoolingWithReheat;
    const needsBoth =
      value === Thermostat.ControlSequenceOfOperation.CoolingAndHeating ||
      value ===
        Thermostat.ControlSequenceOfOperation.CoolingAndHeatingWithReheat;
    if (needsHeat && !hasHeat) {
      return Thermostat.ControlSequenceOfOperation.CoolingOnly;
    }
    if (needsCool && !hasCool) {
      return Thermostat.ControlSequenceOfOperation.HeatingOnly;
    }
    if (needsBoth && !hasHeat) {
      return Thermostat.ControlSequenceOfOperation.CoolingOnly;
    }
    if (needsBoth && !hasCool) {
      return Thermostat.ControlSequenceOfOperation.HeatingOnly;
    }
    return value;
  }

  private clampSetpoint(
    value: number | undefined,
    min: number | undefined,
    max: number | undefined,
    type: "heat" | "cool",
  ): number {
    // Use reasonable defaults if limits not provided
    const effectiveMin = min ?? 0; // 0°C
    const effectiveMax = max ?? 5000; // 50°C

    // If value is undefined or NaN, use a reasonable default based on type
    // Heat defaults to 20°C (2000), Cool defaults to 24°C (2400)
    if (value == null || Number.isNaN(value)) {
      const defaultValue = type === "heat" ? 2000 : 2400;
      logger.debug(
        `${type} setpoint is undefined, using default: ${defaultValue}`,
      );
      return Math.max(effectiveMin, Math.min(effectiveMax, defaultValue));
    }

    // Clamp value to be within limits
    return Math.max(effectiveMin, Math.min(effectiveMax, value));
  }
}

export namespace ThermostatServerBase {
  export type State = InstanceType<typeof ThermostatServerBase.State>;
}

// Feature-specific thermostat variants that share the same implementation
// but advertise only the features they actually support (#136).
// Standard classes omit Presets & Apple 0x1349 MEI so non-adaptive bridges
// keep their exact Matter schema; Adaptive classes enable them opt-in.
export const PRESET_PROTOTYPE_METHODS = new Set([
  "setActivePresetRequest",
  "persistedPresetsChanged",
  "reconcilePersistedPresets",
  "reconcileActivePresetOnUpdate",
  "restoreIntendedPreset",
  "temperatureSetpointHoldChanged",
  "temperatureSetpointHoldDurationChanged",
  "appleAttr000EChanged",
  "applyAppleSetpointHold",
]);

function copyPrototypeMethods(
  source: { prototype: object },
  target: { prototype: object },
  excludePresets = false,
) {
  for (const name of Object.getOwnPropertyNames(source.prototype)) {
    if (
      name === "constructor" ||
      name === "initialize" ||
      (excludePresets && PRESET_PROTOTYPE_METHODS.has(name))
    ) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source.prototype, name);
    if (descriptor) {
      Object.defineProperty(target.prototype, name, descriptor);
    }
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Instantiated by prototype copy and ThermostatServer factory
class AdaptiveHeatingOnlyThermostatServerBase extends AdaptiveHeatingOnlyFeaturedBase {
  declare state: AdaptiveHeatingOnlyThermostatServerBase.State;
  static override State = class extends AdaptiveHeatingOnlyFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }

  override async [Symbol.asyncDispose]() {
    clearEndpointHoldTimers(this.endpoint);
    await super[Symbol.asyncDispose]();
  }
}
namespace AdaptiveHeatingOnlyThermostatServerBase {
  export type State = InstanceType<
    typeof AdaptiveHeatingOnlyThermostatServerBase.State
  >;
}

// biome-ignore lint/correctness/noUnusedVariables: Instantiated by prototype copy and ThermostatServer factory
class AdaptiveCoolingOnlyThermostatServerBase extends AdaptiveCoolingOnlyFeaturedBase {
  declare state: AdaptiveCoolingOnlyThermostatServerBase.State;
  static override State = class extends AdaptiveCoolingOnlyFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }

  override async [Symbol.asyncDispose]() {
    clearEndpointHoldTimers(this.endpoint);
    await super[Symbol.asyncDispose]();
  }
}
namespace AdaptiveCoolingOnlyThermostatServerBase {
  export type State = InstanceType<
    typeof AdaptiveCoolingOnlyThermostatServerBase.State
  >;
}

// biome-ignore lint/correctness/noUnusedVariables: Instantiated by prototype copy and ThermostatServer factory
class AdaptiveHeatingAndCoolingThermostatServerBase extends AdaptiveHeatingAndCoolingFeaturedBase {
  declare state: AdaptiveHeatingAndCoolingThermostatServerBase.State;
  static override State =
    class extends AdaptiveHeatingAndCoolingFeaturedBase.State {
      config!: ThermostatServerConfig;
    };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }

  override async [Symbol.asyncDispose]() {
    clearEndpointHoldTimers(this.endpoint);
    await super[Symbol.asyncDispose]();
  }
}
namespace AdaptiveHeatingAndCoolingThermostatServerBase {
  export type State = InstanceType<
    typeof AdaptiveHeatingAndCoolingThermostatServerBase.State
  >;
}

// biome-ignore lint/correctness/noUnusedVariables: Instantiated by prototype copy and ThermostatServer factory
class StandardFullThermostatServerBase extends StandardFullFeaturedBase {
  declare state: StandardFullThermostatServerBase.State;
  static override State = class extends StandardFullFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }
}
namespace StandardFullThermostatServerBase {
  export type State = InstanceType<
    typeof StandardFullThermostatServerBase.State
  >;
}

// biome-ignore lint/correctness/noUnusedVariables: Instantiated by prototype copy and ThermostatServer factory
class StandardHeatingOnlyThermostatServerBase extends StandardHeatingOnlyFeaturedBase {
  declare state: StandardHeatingOnlyThermostatServerBase.State;
  static override State = class extends StandardHeatingOnlyFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }
}
namespace StandardHeatingOnlyThermostatServerBase {
  export type State = InstanceType<
    typeof StandardHeatingOnlyThermostatServerBase.State
  >;
}

// biome-ignore lint/correctness/noUnusedVariables: Instantiated by prototype copy and ThermostatServer factory
class StandardCoolingOnlyThermostatServerBase extends StandardCoolingOnlyFeaturedBase {
  declare state: StandardCoolingOnlyThermostatServerBase.State;
  static override State = class extends StandardCoolingOnlyFeaturedBase.State {
    config!: ThermostatServerConfig;
  };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }
}
namespace StandardCoolingOnlyThermostatServerBase {
  export type State = InstanceType<
    typeof StandardCoolingOnlyThermostatServerBase.State
  >;
}

// biome-ignore lint/correctness/noUnusedVariables: Instantiated by prototype copy and ThermostatServer factory
class StandardHeatingAndCoolingThermostatServerBase extends StandardHeatingAndCoolingFeaturedBase {
  declare state: StandardHeatingAndCoolingThermostatServerBase.State;
  static override State =
    class extends StandardHeatingAndCoolingFeaturedBase.State {
      config!: ThermostatServerConfig;
    };

  override async initialize() {
    thermostatPreInitialize(this);
    await super.initialize();
    await thermostatPostInitialize(this);
  }
}
namespace StandardHeatingAndCoolingThermostatServerBase {
  export type State = InstanceType<
    typeof StandardHeatingAndCoolingThermostatServerBase.State
  >;
}

copyPrototypeMethods(
  ThermostatServerBase,
  AdaptiveHeatingOnlyThermostatServerBase,
);
copyPrototypeMethods(
  ThermostatServerBase,
  AdaptiveCoolingOnlyThermostatServerBase,
);
copyPrototypeMethods(
  ThermostatServerBase,
  AdaptiveHeatingAndCoolingThermostatServerBase,
);
copyPrototypeMethods(
  ThermostatServerBase,
  StandardFullThermostatServerBase,
  true,
);
copyPrototypeMethods(
  ThermostatServerBase,
  StandardHeatingOnlyThermostatServerBase,
  true,
);
copyPrototypeMethods(
  ThermostatServerBase,
  StandardCoolingOnlyThermostatServerBase,
  true,
);
copyPrototypeMethods(
  ThermostatServerBase,
  StandardHeatingAndCoolingThermostatServerBase,
  true,
);

export interface ThermostatServerFeatures {
  heating: boolean;
  cooling: boolean;
  /**
   * Enable AutoMode (dual setpoint) feature.
   * Only set to true if the device supports heat_cool in HA hvac_modes.
   * Without this, Apple Home won't show the Auto option, preventing
   * mode flipping on devices that only have single-setpoint 'auto'.
   */
  autoMode?: boolean;
}

/**
 * Initial state values for the thermostat.
 * These MUST be provided when creating the behavior to prevent NaN validation errors.
 * Matter.js validates setpoints during initialization BEFORE our initialize() runs.
 */
export interface ThermostatServerInitialState {
  /** Local temperature in 0.01°C units (e.g., 2100 = 21°C). Default: 2100 */
  localTemperature?: number;
  /** Heating setpoint in 0.01°C units (e.g., 2000 = 20°C). Default: 2000 */
  occupiedHeatingSetpoint?: number;
  /** Cooling setpoint in 0.01°C units (e.g., 2400 = 24°C). Default: 2400 */
  occupiedCoolingSetpoint?: number;
  /** Minimum heat setpoint limit. Default: 0 (0°C) */
  minHeatSetpointLimit?: number;
  /** Maximum heat setpoint limit. Default: 5000 (50°C) */
  maxHeatSetpointLimit?: number;
  /** Minimum cool setpoint limit. Default: 0 (0°C) */
  minCoolSetpointLimit?: number;
  /** Maximum cool setpoint limit. Default: 5000 (50°C) */
  maxCoolSetpointLimit?: number;
}

/**
 * Creates a ThermostatServer behavior with the specified config and initial state.
 *
 * CRITICAL: The initialState values are passed DIRECTLY to Matter.js during behavior
 * registration. This is the ONLY way to prevent NaN validation errors, because
 * Matter.js validates setpoints BEFORE our initialize() method runs.
 *
 * Pass ALL thermostat attributes directly to behaviors.require() call.
 *
 * @param config - The thermostat server configuration (getters/setters for HA)
 * @param initialState - Initial attribute values. MUST include valid setpoints!
 */
export function ThermostatServer(
  config: ThermostatServerConfig,
  initialState: ThermostatServerInitialState = {},
  features: ThermostatServerFeatures = { heating: true, cooling: true },
  appleAdaptiveTemperature = false,
) {
  const supportsHeating = features.heating;
  const supportsCooling = features.cooling;

  if (supportsHeating && supportsCooling) {
    if (features.autoMode) {
      const FullBase = appleAdaptiveTemperature
        ? ThermostatServerBase
        : (StandardFullThermostatServerBase as unknown as typeof ThermostatServerBase);
      // Full features (heating + cooling + auto mode) for heat_cool devices
      // IMPORTANT: abs limits → regular limits → setpoints to prevent
      // validation failures for negative temperatures (e.g. refrigerators).
      return FullBase.set({
        config,
        absMinHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
        absMaxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
        absMinCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
        absMaxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
        minHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
        maxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
        minCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
        maxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
        localTemperature: initialState.localTemperature ?? 2100,
        occupiedHeatingSetpoint: initialState.occupiedHeatingSetpoint ?? 2000,
        occupiedCoolingSetpoint: initialState.occupiedCoolingSetpoint ?? 2400,
        minSetpointDeadBand: 0,
      });
    }

    const HeatAndCoolBase = appleAdaptiveTemperature
      ? AdaptiveHeatingAndCoolingThermostatServerBase
      : StandardHeatingAndCoolingThermostatServerBase;
    // Heating + Cooling without AutoMode (for ACs with heat+cool but no heat_cool)
    // Apple Home won't show Auto option, preventing mode flipping issues.
    return HeatAndCoolBase.set({
      config,
      absMinHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
      absMaxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
      absMinCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
      absMaxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
      minHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
      maxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
      minCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
      maxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
      localTemperature: initialState.localTemperature ?? 2100,
      occupiedHeatingSetpoint: initialState.occupiedHeatingSetpoint ?? 2000,
      occupiedCoolingSetpoint: initialState.occupiedCoolingSetpoint ?? 2400,
    });
  }

  if (supportsCooling) {
    const CoolBase = appleAdaptiveTemperature
      ? AdaptiveCoolingOnlyThermostatServerBase
      : StandardCoolingOnlyThermostatServerBase;
    // Cooling only - no Heating or AutoMode features
    return CoolBase.set({
      config,
      absMinCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
      absMaxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
      minCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
      maxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
      localTemperature: initialState.localTemperature ?? 2100,
      occupiedCoolingSetpoint: initialState.occupiedCoolingSetpoint ?? 2400,
    });
  }

  const HeatBase = appleAdaptiveTemperature
    ? AdaptiveHeatingOnlyThermostatServerBase
    : StandardHeatingOnlyThermostatServerBase;
  // Heating only (default) - no Cooling or AutoMode features
  return HeatBase.set({
    config,
    absMinHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
    absMaxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
    minHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
    maxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
    localTemperature: initialState.localTemperature ?? 2100,
    occupiedHeatingSetpoint: initialState.occupiedHeatingSetpoint ?? 2000,
  });
}
