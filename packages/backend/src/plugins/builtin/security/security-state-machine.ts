// Pure alarm state machine for the security plugin. No wall clock, no HA, no
// matter.js: config plus events in, effects out, timers via an injectable
// scheduler. The plugin wires the effects to devices and service calls.

export type ArmMode = "home" | "away" | "night" | "vacation";
export const ARM_MODES: readonly ArmMode[] = [
  "home",
  "away",
  "night",
  "vacation",
];

export type SecurityPhase =
  | "disarmed"
  | "arming"
  | "armed"
  | "pending"
  | "triggered";

export type AlertTier = ArmMode | "24h";

export interface SecuritySnapshot {
  mode: ArmMode | null;
  phase: SecurityPhase;
  /**
   * False when the mode's setters never ran, a trip during the exit delay.
   * Absent in old snapshots, read as true.
   */
  modeReached?: boolean;
}

export interface ObservedSecurityState {
  /** Omit the mode for phase-only updates such as pending or triggered. */
  mode?: ArmMode | null;
  phase?: SecurityPhase;
}

export interface SecurityMachineConfig {
  /** Exit delay before an armed mode takes effect. 0 arms immediately. */
  exitDelaySeconds: number;
  /** Entry delay for perimeter triggers while armed. 0 trips immediately. */
  entryDelaySeconds: number;
  /** Time the alarm stays triggered before returning. 0 holds until disarm. */
  triggerTimeSeconds: number;
  triggers: Record<ArmMode, string[]>;
  /** Active in every state including disarmed, entry delay never applies. */
  triggers24h: string[];
}

export interface SecurityEffects {
  /** Exclusive mode switch states to report to the endpoints. */
  switchStates(states: Record<ArmMode, boolean>): void;
  /** An armed mode took effect: run that mode's setters. */
  modeReached(mode: ArmMode): void;
  /** Disarmed: run the off setters. */
  disarmed(): void;
  /** Alarm tripped: fire the tier's alerts and open the contact sensor. */
  tripped(tier: AlertTier, entityId: string): void;
  /** Left triggered: silence alerts and close the contact sensor. */
  alarmCleared(): void;
  /** State changed, write it to plugin storage. */
  persist(snapshot: SecuritySnapshot): void;
}

export interface SecurityScheduler {
  /** Schedules fn once after ms; the returned function cancels it. */
  schedule(ms: number, fn: () => void): () => void;
}

export const defaultSecurityScheduler: SecurityScheduler = {
  schedule(ms, fn) {
    // Plain captured timer, unref so it never holds the process open.
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

// Comma-separated entity list, split the same way the camera plugin splits its
// cameras field. Deduped, first occurrence wins.
export function parseEntityList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

// Alert domains that get a turn_off when the alarm clears.
export const SILENCEABLE_ALERT_DOMAINS: ReadonlySet<string> = new Set([
  "siren",
  "switch",
  "light",
]);
// One-shot alert domains, invoked on a trip but never turned off.
const FIRE_ONLY_ALERT_DOMAINS: ReadonlySet<string> = new Set([
  "script",
  "scene",
]);

export interface ResolvedSecurityLists {
  setters: Record<ArmMode, string[]>;
  offSetters: string[];
  triggers: Record<ArmMode, string[]>;
  triggers24h: string[];
  alerts: Record<ArmMode, string[]>;
  alerts24h: string[];
  alwaysAlerts: string[];
}

// Effective lists from the flat plugin config. Empty vacation lists fall back
// to the away lists, everything else is taken as configured. Alert lists only
// accept domains the clear can silence plus the one-shot script/scene pair;
// anything else is dropped with one warning per entity.
export function resolveSecurityLists(
  config: Record<string, unknown>,
  warn?: (message: string) => void,
): ResolvedSecurityLists {
  const warned = new Set<string>();
  const alerts = (value: unknown): string[] =>
    parseEntityList(value).filter((id) => {
      const domain = id.split(".")[0];
      if (
        SILENCEABLE_ALERT_DOMAINS.has(domain) ||
        FIRE_ONLY_ALERT_DOMAINS.has(domain)
      ) {
        return true;
      }
      if (!warned.has(id)) {
        warned.add(id);
        warn?.(
          `alert entity ${id} dropped, only siren/switch/light and script/scene are supported`,
        );
      }
      return false;
    });
  const awaySetters = parseEntityList(config.awaySetters);
  const awayTriggers = parseEntityList(config.awayTriggers);
  const awayAlerts = alerts(config.awayAlerts);
  const vacationSetters = parseEntityList(config.vacationSetters);
  const vacationTriggers = parseEntityList(config.vacationTriggers);
  const vacationAlerts = alerts(config.vacationAlerts);
  return {
    setters: {
      home: parseEntityList(config.homeSetters),
      away: awaySetters,
      night: parseEntityList(config.nightSetters),
      vacation: vacationSetters.length > 0 ? vacationSetters : awaySetters,
    },
    offSetters: parseEntityList(config.offSetters),
    triggers: {
      home: parseEntityList(config.homeTriggers),
      away: awayTriggers,
      night: parseEntityList(config.nightTriggers),
      vacation: vacationTriggers.length > 0 ? vacationTriggers : awayTriggers,
    },
    triggers24h: parseEntityList(config.triggers24h),
    alerts: {
      home: alerts(config.homeAlerts),
      away: awayAlerts,
      night: alerts(config.nightAlerts),
      vacation: vacationAlerts.length > 0 ? vacationAlerts : awayAlerts,
    },
    alerts24h: alerts(config.alerts24h),
    alwaysAlerts: alerts(config.alwaysAlerts),
  };
}

// The alerts to fire for a trip: the tier's list plus the always list, deduped.
export function alertsForTier(
  lists: ResolvedSecurityLists,
  tier: AlertTier,
): string[] {
  const base = tier === "24h" ? lists.alerts24h : lists.alerts[tier];
  return [...new Set([...base, ...lists.alwaysAlerts])];
}

// Every entity the plugin has to watch on the HA event stream.
export function watchedTriggerEntities(
  lists: ResolvedSecurityLists,
): Set<string> {
  const all = new Set<string>(lists.triggers24h);
  for (const mode of ARM_MODES) {
    for (const id of lists.triggers[mode]) all.add(id);
  }
  return all;
}

// Perimeter sensors get the entry delay; everything else trips instantly.
export const PERIMETER_DEVICE_CLASSES: ReadonlySet<string> = new Set([
  "door",
  "window",
  "garage_door",
  "opening",
]);

export function isPerimeterTrigger(
  entityId: string,
  deviceClass: string | undefined,
): boolean {
  return (
    entityId.startsWith("binary_sensor.") &&
    deviceClass != null &&
    PERIMETER_DEVICE_CLASSES.has(deviceClass)
  );
}

export class SecurityStateMachine {
  private mode: ArmMode | null = null;
  private phase: SecurityPhase = "disarmed";
  // Where a triggered alarm returns to when the trigger time runs out.
  private returnMode: ArmMode | null = null;
  // Tier of the current trip, only meaningful while triggered.
  private trippedTier: AlertTier | null = null;
  // False while an exit delay is still running, so an auto-return after a
  // trip that cut the delay short can run the setters late.
  private modeReachedRan = true;
  private cancelTimer?: () => void;

  constructor(
    private config: SecurityMachineConfig,
    private readonly effects: SecurityEffects,
    private readonly scheduler: SecurityScheduler = defaultSecurityScheduler,
  ) {}

  get snapshot(): SecuritySnapshot {
    return { mode: this.mode, phase: this.phase };
  }

  // Live config swap: state survives, already running timers keep the delay
  // they started with.
  setConfig(config: SecurityMachineConfig): void {
    this.config = config;
  }

  // Applied once on start from the persisted snapshot. Interrupted delays
  // resolve to armed; triggered stays only when the trigger time is infinite.
  // A resolution that changed the phase is persisted right away so a second
  // restart replays no effects. An interrupted exit delay is the one case
  // where the setters never ran, so that restore dispatches modeReached.
  restore(snapshot: SecuritySnapshot | undefined): void {
    if (!snapshot) return;
    const mode = ARM_MODES.includes(snapshot.mode as ArmMode)
      ? (snapshot.mode as ArmMode)
      : null;
    const reached = snapshot.modeReached ?? true;
    switch (snapshot.phase) {
      case "arming":
      case "pending":
      case "armed":
        if (mode) {
          this.mode = mode;
          this.phase = "armed";
          this.modeReachedRan = true;
          if (snapshot.phase !== "armed") this.persist();
          if (snapshot.phase === "arming") this.effects.modeReached(mode);
        }
        break;
      case "triggered":
        if (this.config.triggerTimeSeconds === 0) {
          this.mode = mode;
          this.returnMode = mode;
          this.phase = "triggered";
          this.modeReachedRan = reached;
        } else {
          if (mode) {
            this.mode = mode;
            this.phase = "armed";
            this.modeReachedRan = true;
          }
          this.persist();
          // A trip during the exit delay went to triggered with the setters
          // never run; this resolution to armed is the only chance to run
          // them.
          if (mode && !reached) this.effects.modeReached(mode);
        }
        break;
      default:
        break;
    }
  }

  // A mode switch changed on the Matter side. Exclusivity lives here: arming
  // one mode reports the other three off, turning the active one off disarms.
  handleModeSwitch(mode: ArmMode, on: boolean): void {
    if (on) {
      if (this.mode === mode && this.phase !== "disarmed") {
        this.reportSwitches();
        return;
      }
      this.arm(mode);
    } else if (
      (this.mode === mode && this.phase !== "disarmed") ||
      (this.mode === null && this.phase === "triggered")
    ) {
      this.disarm();
    } else {
      this.reportSwitches();
    }
  }

  arm(mode: ArmMode): void {
    const wasTriggered = this.phase === "triggered";
    this.clearTimer();
    this.mode = mode;
    this.returnMode = null;
    const delayMs = this.config.exitDelaySeconds * 1000;
    if (delayMs > 0) {
      this.phase = "arming";
      this.modeReachedRan = false;
      this.reportSwitches();
      if (wasTriggered) this.effects.alarmCleared();
      this.persist();
      this.cancelTimer = this.scheduler.schedule(delayMs, () =>
        this.becomeArmed(),
      );
    } else {
      this.phase = "armed";
      this.modeReachedRan = true;
      this.reportSwitches();
      if (wasTriggered) this.effects.alarmCleared();
      this.persist();
      this.effects.modeReached(mode);
    }
  }

  disarm(): void {
    if (this.phase === "disarmed") {
      this.reportSwitches();
      return;
    }
    const wasTriggered = this.phase === "triggered";
    this.clearTimer();
    this.mode = null;
    this.returnMode = null;
    this.phase = "disarmed";
    this.reportSwitches();
    if (wasTriggered) this.effects.alarmCleared();
    this.persist();
    this.effects.disarmed();
  }

  // A watched entity entered on/open. The 24h list trips in every state and
  // skips the entry delay; mode triggers only count while armed (the exit
  // delay exists so leaving does not trip the alarm).
  handleEntityOn(entityId: string, isPerimeter: boolean): void {
    if (this.config.triggers24h.includes(entityId)) {
      // A mode-tier trip must not swallow a safety trigger: the 24h alerts
      // fire on top and the hold restarts. During a 24h trip they are
      // already blaring.
      if (this.phase !== "triggered" || this.trippedTier !== "24h") {
        this.trip("24h", entityId);
      }
      return;
    }
    const mode = this.mode;
    if (!mode) return;
    if (!this.config.triggers[mode].includes(entityId)) return;
    if (this.phase === "armed") {
      const entryMs = this.config.entryDelaySeconds * 1000;
      if (isPerimeter && entryMs > 0) {
        this.phase = "pending";
        this.persist();
        this.cancelTimer = this.scheduler.schedule(entryMs, () =>
          this.trip(mode, entityId),
        );
      } else {
        this.trip(mode, entityId);
      }
    } else if (this.phase === "pending" && !isPerimeter) {
      // An instant class cuts the entry delay short.
      this.trip(mode, entityId);
    }
  }

  // Mirrors a state owned by an external alarm panel. This observation path
  // updates only the reported switches and persisted snapshot: local setters,
  // alerts and silence handlers must not run for an alarm owned elsewhere.
  applyObservedState(state: ObservedSecurityState): boolean {
    this.clearTimer();
    let nextMode =
      state.mode === undefined
        ? this.mode
        : this.normalizeObservedMode(state.mode);
    const nextPhase = this.normalizeObservedPhase(state.phase, nextMode);
    if (nextPhase === "disarmed") nextMode = null;

    if (this.mode === nextMode && this.phase === nextPhase) {
      this.reportSwitches();
      return false;
    }

    this.mode = nextMode;
    this.phase = nextPhase;
    this.returnMode = nextPhase === "triggered" ? nextMode : null;
    this.trippedTier = null;
    this.modeReachedRan = true;
    this.reportSwitches();
    this.persist();
    return true;
  }

  shutdown(): void {
    this.clearTimer();
  }

  private becomeArmed(): void {
    this.cancelTimer = undefined;
    const mode = this.mode;
    if (!mode || this.phase !== "arming") return;
    this.phase = "armed";
    this.modeReachedRan = true;
    this.persist();
    this.effects.modeReached(mode);
  }

  private trip(tier: AlertTier, entityId: string): void {
    this.clearTimer();
    this.returnMode = this.mode;
    this.trippedTier = tier;
    this.phase = "triggered";
    this.effects.tripped(tier, entityId);
    this.persist();
    const holdMs = this.config.triggerTimeSeconds * 1000;
    if (holdMs > 0) {
      this.cancelTimer = this.scheduler.schedule(holdMs, () =>
        this.autoReturn(),
      );
    }
  }

  private autoReturn(): void {
    this.cancelTimer = undefined;
    this.mode = this.returnMode;
    this.returnMode = null;
    this.phase = this.mode ? "armed" : "disarmed";
    // A trip during the exit delay cancelled becomeArmed, run the setters now.
    const lateSetters = this.mode != null && !this.modeReachedRan;
    this.modeReachedRan = true;
    this.effects.alarmCleared();
    this.persist();
    if (lateSetters && this.mode) this.effects.modeReached(this.mode);
  }

  private reportSwitches(): void {
    const active = this.phase === "disarmed" ? null : this.mode;
    const states = {} as Record<ArmMode, boolean>;
    for (const mode of ARM_MODES) states[mode] = mode === active;
    this.effects.switchStates(states);
  }

  private normalizeObservedMode(mode: ObservedSecurityState["mode"]) {
    if (mode == null) return null;
    return ARM_MODES.includes(mode) ? mode : null;
  }

  private normalizeObservedPhase(
    phase: ObservedSecurityState["phase"],
    mode: ArmMode | null,
  ): SecurityPhase {
    if (phase === "triggered") return phase;
    if (phase === "arming" || phase === "pending" || phase === "armed") {
      return mode ? phase : "disarmed";
    }
    return mode ? "armed" : "disarmed";
  }

  private persist(): void {
    this.effects.persist({
      ...this.snapshot,
      modeReached: this.modeReachedRan,
    });
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
}
