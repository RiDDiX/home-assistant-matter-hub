import { Logger } from "@matter/general";
import {
  type Connection,
  callService,
  createConnection,
  createLongLivedTokenAuth,
  type HassEntity,
} from "home-assistant-js-websocket";
import { sendHaMessage } from "../../../utils/send-ha-message.js";
import type {
  MatterHubPlugin,
  PluginConfigSchema,
  PluginContext,
} from "../../types.js";
import {
  ARM_MODES,
  type ArmMode,
  alertsForTier,
  isPerimeterTrigger,
  type ObservedSecurityState,
  type ResolvedSecurityLists,
  resolveSecurityLists,
  type SecurityEffects,
  type SecurityMachineConfig,
  type SecuritySnapshot,
  SecurityStateMachine,
  SILENCEABLE_ALERT_DOMAINS,
  watchedTriggerEntities,
} from "./security-state-machine.js";

interface SecurityConfig {
  haUrl?: string;
  haToken?: string;
  sourceAlarmPanel?: string;
  exitDelaySeconds?: number;
  entryDelaySeconds?: number;
  triggerTimeSeconds?: number;
  homeSetters?: string;
  homeTriggers?: string;
  homeAlerts?: string;
  awaySetters?: string;
  awayTriggers?: string;
  awayAlerts?: string;
  nightSetters?: string;
  nightTriggers?: string;
  nightAlerts?: string;
  vacationSetters?: string;
  vacationTriggers?: string;
  vacationAlerts?: string;
  offSetters?: string;
  triggers24h?: string;
  alerts24h?: string;
  alwaysAlerts?: string;
}

interface SecurityPluginDeps {
  /** Test seam: open the HA websocket. Defaults to a real long-lived dial. */
  connect?: (haUrl: string, haToken: string) => Promise<Connection>;
}

// Shape of the HA state_changed events we care about.
interface HaStateChangedEvent {
  data?: {
    entity_id?: string;
    old_state?: { state?: string } | null;
    new_state?: {
      state?: string;
      attributes?: { device_class?: string };
    } | null;
  };
}

const CONFIG_KEY = "config";
const STATE_KEY = "state";
// Alerts whose turn_off is due but not yet confirmed by HA.
const PENDING_SILENCE_KEY = "pendingSilence";
// Setters that hit a connection gap, replayed on reconnect if still current.
const PENDING_SETTERS_KEY = "pendingSetters";

const ALARM_DEVICE_ID = "alarm";
const MODE_DEVICE_IDS: Record<ArmMode, string> = {
  home: "mode_home",
  away: "mode_away",
  night: "mode_night",
  vacation: "mode_vacation",
};
const MODE_NAMES: Record<ArmMode, string> = {
  home: "Home",
  away: "Away",
  night: "Night",
  vacation: "Vacation",
};

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;
// A service call that has not settled by then counts as failed, so a hung
// socket cannot wedge the effect queue.
const CALL_DEADLINE_MS = 10_000;
// A source panel that swallows a write without any state change (Alarmo open
// sensor refusal, missing entity) sends no event; reconcile the endpoints then.
const SOURCE_WRITE_RECONCILE_MS = 5_000;

// The machine snapshot plus the alert entities the current trip turned on.
interface StoredSecurityState extends SecuritySnapshot {
  activeAlerts?: string[];
}

// gen is stamped at enqueue time; the drain drops tasks left over from
// before a teardown instead of firing them against the next connection.
type EffectTask = (
  | { kind: "setters"; mode: ArmMode | "off" }
  | { kind: "alerts"; entities: string[] }
  | { kind: "silence"; entities: string[] }
  | { kind: "reconnect" }
) & { gen?: number };

// A small alarm system: four exclusive mode switches (Home/Away/Night/
// Vacation) plus an Alarm contact sensor. All switches off means disarmed.
// The state machine itself is pure, see security-state-machine.ts; this class
// wires it to the plugin devices and to Home Assistant.
//
// By default this runs its own state machine in plugin storage. When a source
// alarm panel is configured, Home Assistant owns the alarm state: this plugin
// mirrors that panel and forwards Matter mode writes back to it.
export class SecurityPlugin implements MatterHubPlugin {
  readonly name = "security";
  readonly version = "0.1.0";

  private readonly log = Logger.get("SecurityPlugin");
  private context?: PluginContext;
  private config: SecurityConfig;
  private lists: ResolvedSecurityLists = resolveSecurityLists({});
  private watched = new Set<string>();
  private machine?: SecurityStateMachine;
  private activeAlerts: string[] = [];
  // Effect tasks run strictly FIFO: a disarm's silence can never overtake the
  // trip's turn_on loop it is chasing. Queued (not yet started) intent is
  // coalesced per entity so a hung call cannot pile up work behind it.
  private tasks: EffectTask[] = [];
  private draining = false;
  // Bumped on every teardown and bring-up; queued tasks from an older
  // generation never dispatch.
  private effectGeneration = 0;

  // The mode a Matter write asked the source panel to arm; HA's arming and
  // pending states carry no mode, this keeps the chosen switch on meanwhile.
  private pendingArmMode: ArmMode | null = null;
  private sourceWriteReconcile?: ReturnType<typeof setTimeout>;
  // Bumped per source write; a settling call acts only when it is still the
  // latest, so an old write cannot clear a newer write's pending mode.
  private sourceWriteSeq = 0;

  private connection?: Connection;
  private unsubscribeEvents?: () => Promise<void> | void;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private backoffMs = RETRY_BASE_MS;
  // Bumped on every teardown; a dial resolving under a stale generation is
  // discarded instead of installing an old target.
  private dialGeneration = 0;

  constructor(
    config: SecurityConfig = {},
    private readonly deps: SecurityPluginDeps = {},
  ) {
    this.config = config;
  }

  async onStart(context: PluginContext): Promise<void> {
    this.context = context;
    // Persisted config wins; the constructor value is just a seed.
    const stored = await context.storage.get<SecurityConfig>(CONFIG_KEY);
    this.config = { ...this.config, ...(stored ?? {}) };
    this.applyLists();
    // Without a trigger or source panel the alarm can never change, so an
    // untouched install must not spill five endpoints onto the bridge (#439).
    if (!this.isConfigured()) {
      this.log.info(
        "no trigger entities or source alarm panel configured, the security devices stay unregistered",
      );
      return;
    }
    await this.bringUp();
  }

  private isConfigured(): boolean {
    return this.watched.size > 0 || this.sourceAlarmPanel() != null;
  }

  private async bringUp(): Promise<void> {
    const context = this.context;
    if (!context) return;
    this.effectGeneration++;
    this.machine = new SecurityStateMachine(
      this.machineConfig(),
      this.effects(),
    );
    await this.registerDevices();
    const state = await context.storage.get<StoredSecurityState>(STATE_KEY);
    if (this.sourceAlarmPanel()) {
      if (state) {
        this.machine.applyObservedState({
          mode: state.mode,
          phase: state.phase,
        });
      }
      // Anything the local machine switched on has no owner in mirror mode;
      // sweep it off instead of stranding a live siren.
      const orphaned = [
        ...new Set([...this.activeAlerts, ...(state?.activeAlerts ?? [])]),
      ].filter((id) => SILENCEABLE_ALERT_DOMAINS.has(id.split(".")[0]));
      if (orphaned.length > 0) this.enqueueSilence(orphaned);
      this.activeAlerts = [];
    } else {
      // A restart mid-armed comes back armed, see restore() for the resolution
      // of interrupted delays.
      this.machine.restore(state);
      if (state?.phase === "triggered") {
        // The pre-restart trip's alert set travels in the snapshot. Old
        // snapshots without it fall back to anything any tier could have
        // started.
        const known = state.activeAlerts;
        if (this.machine.snapshot.phase === "triggered") {
          // Still triggered: arm the first clear.
          this.activeAlerts = known ?? this.allSilenceableAlerts();
        } else {
          // A finite trigger time resolved the restore out of triggered, so no
          // disarm will ever clear the pre-restart sirens. Silence them now.
          const candidates = (known ?? this.allSilenceableAlerts()).filter(
            (id) => SILENCEABLE_ALERT_DOMAINS.has(id.split(".")[0]),
          );
          this.enqueueSilence(candidates);
        }
      }
    }
    // The resolved snapshot goes to disk before any of its effects dispatch.
    await context.storage.flush?.();
    this.pushDeviceStates();
    this.startConnection();
  }

  private async tearDown(): Promise<void> {
    this.machine?.shutdown();
    this.machine = undefined;
    // Queued effects belong to the closed connection and its config; the
    // next bring-up must not replay them (#439 review).
    this.tasks = [];
    this.effectGeneration++;
    await this.stopConnection();
    for (const id of [...Object.values(MODE_DEVICE_IDS), ALARM_DEVICE_ID]) {
      await this.context?.unregisterDevice(id).catch(() => {});
    }
  }

  async onConfigChanged(config: Record<string, unknown>): Promise<void> {
    const previousSource = this.sourceAlarmPanel();
    this.config = config as SecurityConfig;
    await this.context?.storage.set(CONFIG_KEY, this.config);
    this.applyLists();
    if (!this.isConfigured()) {
      if (this.machine) {
        this.log.info(
          "security config has no trigger entities or source alarm panel, removing the security devices",
        );
        await this.tearDown();
      }
      return;
    }
    if (!this.machine) {
      // First real config: the devices mount now, no bridge restart needed.
      await this.bringUp();
      return;
    }
    if (previousSource !== this.sourceAlarmPanel()) {
      await this.tearDown();
      await this.bringUp();
      return;
    }
    // Rewire triggers live, the arm state survives. Between the teardown and
    // the new subscribe there is a short monitoring gap; trigger events in it
    // are lost.
    this.machine.setConfig(this.machineConfig());
    await this.stopConnection();
    this.startConnection();
  }

  async onShutdown(): Promise<void> {
    await this.tearDown();
  }

  getCurrentConfig(): Record<string, unknown> {
    return { ...this.config };
  }

  getConfigSchema(): PluginConfigSchema {
    const entityList = (title: string, description: string) => ({
      type: "string" as const,
      title,
      description,
      required: false,
    });
    return {
      title: "Security",
      description:
        "A small alarm system: four exclusive mode switches plus an Alarm " +
        "contact sensor. All entity fields are comma-separated lists.",
      properties: {
        exitDelaySeconds: {
          type: "number",
          title: "Exit delay (seconds)",
          description: "Delay before an armed mode takes effect. 0 disables.",
          default: 60,
          required: false,
        },
        entryDelaySeconds: {
          type: "number",
          title: "Entry delay (seconds)",
          description:
            "Delay for door/window/garage door/opening sensors while armed. " +
            "Other trigger classes trip instantly. 0 disables.",
          default: 60,
          required: false,
        },
        triggerTimeSeconds: {
          type: "number",
          title: "Trigger time (seconds)",
          description:
            "How long the alarm stays triggered before returning to the " +
            "state it was tripped from. 0 keeps it triggered until disarm.",
          default: 120,
          required: false,
        },
        sourceAlarmPanel: {
          type: "string",
          title: "Source alarm panel",
          description:
            "Existing alarm_control_panel.* entity to mirror. When set, " +
            "Home Assistant owns the state and Matter mode changes call its alarm services.",
          required: false,
        },
        homeSetters: entityList(
          "Home setters",
          "Invoked when Home is armed, e.g. scene.arm_home,script.notify",
        ),
        homeTriggers: entityList(
          "Home triggers",
          "Sensors that trip the alarm while armed Home.",
        ),
        homeAlerts: entityList(
          "Home alerts",
          "Turned on when the alarm trips while armed Home.",
        ),
        awaySetters: entityList("Away setters", "Invoked when Away is armed."),
        awayTriggers: entityList(
          "Away triggers",
          "Sensors that trip the alarm while armed Away.",
        ),
        awayAlerts: entityList(
          "Away alerts",
          "Turned on when the alarm trips while armed Away.",
        ),
        nightSetters: entityList(
          "Night setters",
          "Invoked when Night is armed.",
        ),
        nightTriggers: entityList(
          "Night triggers",
          "Sensors that trip the alarm while armed Night.",
        ),
        nightAlerts: entityList(
          "Night alerts",
          "Turned on when the alarm trips while armed Night.",
        ),
        vacationSetters: entityList(
          "Vacation setters",
          "Leave empty to use the Away setters.",
        ),
        vacationTriggers: entityList(
          "Vacation triggers",
          "Leave empty to use the Away triggers.",
        ),
        vacationAlerts: entityList(
          "Vacation alerts",
          "Leave empty to use the Away alerts.",
        ),
        offSetters: entityList(
          "Off setters",
          "Invoked on disarm, e.g. scene.alarm_off",
        ),
        triggers24h: entityList(
          "24h triggers",
          "Trip the alarm in every state including disarmed, without entry " +
            "delay. For smoke, gas, water leak and similar.",
        ),
        alerts24h: entityList(
          "24h alerts",
          "Turned on when a 24h trigger trips the alarm.",
        ),
        alwaysAlerts: entityList(
          "Always",
          "The master alert list: fired on every trip in addition to the " +
            "tier's alerts.",
        ),
        haUrl: {
          type: "string",
          title: "Home Assistant URL",
          description:
            "e.g. http://homeassistant.local:8123. Set together with the " +
            "token to use a different Home Assistant; leave both empty to " +
            "use the bridge's credentials. One without the other is ignored.",
          required: false,
        },
        haToken: {
          type: "string",
          title: "Long-lived access token",
          description:
            "Token for the custom URL, only used together with it. Leave " +
            "both empty to use the bridge's credentials.",
          required: false,
          secret: true,
        },
      },
    };
  }

  // A watched entity changed state, from the websocket or from tests.
  handleTriggerEvent(
    entityId: string,
    state: string,
    deviceClass?: string,
  ): void {
    if (this.sourceAlarmPanel()) return;
    if (state !== "on" && state !== "open") return;
    if (!this.watched.has(entityId)) return;
    this.machine?.handleEntityOn(
      entityId,
      isPerimeterTrigger(entityId, deviceClass),
    );
  }

  private applyLists(): void {
    this.lists = resolveSecurityLists(
      this.config as Record<string, unknown>,
      (message) => this.log.warn(message),
    );
    this.watched = watchedTriggerEntities(this.lists);
    const source = this.config.sourceAlarmPanel?.trim();
    if (source && !source.startsWith("alarm_control_panel.")) {
      this.log.warn(
        `source alarm panel ignored, expected alarm_control_panel.* but got ${source}`,
      );
    }
  }

  private machineConfig(): SecurityMachineConfig {
    const seconds = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : fallback;
    return {
      exitDelaySeconds: seconds(this.config.exitDelaySeconds, 60),
      entryDelaySeconds: seconds(this.config.entryDelaySeconds, 60),
      triggerTimeSeconds: seconds(this.config.triggerTimeSeconds, 120),
      triggers: this.lists.triggers,
      triggers24h: this.lists.triggers24h,
    };
  }

  private effects(): SecurityEffects {
    return {
      switchStates: (states) => {
        for (const mode of ARM_MODES) {
          this.context?.updateDeviceState(MODE_DEVICE_IDS[mode], "onOff", {
            onOff: states[mode],
          });
        }
      },
      modeReached: (mode) => {
        this.enqueueSetters(mode);
      },
      disarmed: () => {
        this.enqueueSetters("off");
      },
      tripped: (tier, entityId) => {
        this.log.info(`alarm tripped by ${entityId} (${tier})`);
        this.context?.updateDeviceState(ALARM_DEVICE_ID, "booleanState", {
          stateValue: false,
        });
        const alerts = alertsForTier(this.lists, tier);
        // Union: a 24h escalation stacks on the mode tier's alerts, one clear
        // silences both sets.
        this.activeAlerts = [...new Set([...this.activeAlerts, ...alerts])];
        this.enqueueAlerts(alerts);
      },
      alarmCleared: () => {
        this.context?.updateDeviceState(ALARM_DEVICE_ID, "booleanState", {
          stateValue: true,
        });
        const toSilence = this.activeAlerts.filter((id) =>
          SILENCEABLE_ALERT_DOMAINS.has(id.split(".")[0]),
        );
        this.activeAlerts = [];
        this.enqueueSilence(toSilence);
      },
      persist: (snapshot) => {
        const state: StoredSecurityState = {
          ...snapshot,
          activeAlerts: [...this.activeAlerts],
        };
        void this.context?.storage
          .set(STATE_KEY, state)
          .catch((e) => this.log.warn("failed to persist alarm state:", e));
      },
    };
  }

  private setters(key: ArmMode | "off"): string[] {
    return key === "off" ? this.lists.offSetters : this.lists.setters[key];
  }

  // Every alert a clear can turn off, across all tiers.
  private allSilenceableAlerts(): string[] {
    const all = new Set([
      ...ARM_MODES.flatMap((mode) => this.lists.alerts[mode]),
      ...this.lists.alerts24h,
      ...this.lists.alwaysAlerts,
    ]);
    return [...all].filter((id) =>
      SILENCEABLE_ALERT_DOMAINS.has(id.split(".")[0]),
    );
  }

  private async registerDevices(): Promise<void> {
    const context = this.context;
    if (!context) return;
    for (const mode of ARM_MODES) {
      await context.registerDevice({
        id: MODE_DEVICE_IDS[mode],
        name: MODE_NAMES[mode],
        deviceType: "on_off_plugin_unit",
        clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
        onAttributeWrite: async (clusterId, attribute, value) => {
          if (clusterId !== "onOff" || attribute !== "onOff") return;
          if (this.sourceAlarmPanel()) {
            await this.handleSourceModeWrite(mode, value === true);
            return;
          }
          this.machine?.handleModeSwitch(mode, value === true);
        },
      });
    }
    await context.registerDevice({
      id: ALARM_DEVICE_ID,
      name: "Alarm",
      deviceType: "contact_sensor",
      // stateValue true = closed = all quiet; false = open = tripped.
      clusters: [
        { clusterId: "booleanState", attributes: { stateValue: true } },
      ],
    });
  }

  private sourceAlarmPanel(): string | undefined {
    const raw = this.config.sourceAlarmPanel;
    const source = typeof raw === "string" ? raw.trim() : undefined;
    // Full-id match: HA treats a comma list as multiple targets, so a loose
    // prefix check would let one setting fan writes out to several entities.
    return source && /^alarm_control_panel\.[a-z0-9_]+$/.test(source)
      ? source
      : undefined;
  }

  // Reflect the restored snapshot onto the endpoints.
  private pushDeviceStates(): void {
    const context = this.context;
    const machine = this.machine;
    if (!context || !machine) return;
    const snap = machine.snapshot;
    for (const mode of ARM_MODES) {
      context.updateDeviceState(MODE_DEVICE_IDS[mode], "onOff", {
        onOff: snap.mode === mode && snap.phase !== "disarmed",
      });
    }
    context.updateDeviceState(ALARM_DEVICE_ID, "booleanState", {
      stateValue: snap.phase !== "triggered",
    });
  }

  private pushTask(task: EffectTask): void {
    task.gen = this.effectGeneration;
    this.tasks.push(task);
    // Start the drain a microtask late so the persist that follows the same
    // machine transition lands in storage before any flush barrier runs.
    queueMicrotask(() => void this.drain());
  }

  private enqueueSetters(mode: ArmMode | "off"): void {
    // Only the newest mode intent matters, a queued older one is stale.
    this.tasks = this.tasks.filter((t) => t.kind !== "setters");
    this.pushTask({ kind: "setters", mode });
  }

  private enqueueAlerts(entityIds: string[]): void {
    this.dropQueuedIntent("silence", entityIds);
    const queued = this.tasks.find((t) => t.kind === "alerts");
    if (queued && queued.kind === "alerts") {
      queued.entities = [...new Set([...queued.entities, ...entityIds])];
      return;
    }
    this.pushTask({ kind: "alerts", entities: [...entityIds] });
  }

  private enqueueSilence(entityIds: string[]): void {
    this.dropQueuedIntent("alerts", entityIds);
    const queued = this.tasks.find((t) => t.kind === "silence");
    if (queued && queued.kind === "silence") {
      queued.entities = [...new Set([...queued.entities, ...entityIds])];
      return;
    }
    this.pushTask({ kind: "silence", entities: [...entityIds] });
  }

  private enqueueReconnect(): void {
    if (this.tasks.some((t) => t.kind === "reconnect")) return;
    this.pushTask({ kind: "reconnect" });
  }

  // A newer turn_on/turn_off intent for an entity replaces the queued
  // opposite one. Only queued tasks are touched, an in-flight batch keeps
  // its order guarantee.
  private dropQueuedIntent(
    kind: "alerts" | "silence",
    entityIds: string[],
  ): void {
    const drop = new Set(entityIds);
    this.tasks = this.tasks.flatMap((t) => {
      if (t.kind !== kind) return [t];
      const rest = t.entities.filter((id) => !drop.has(id));
      return rest.length > 0 ? [{ ...t, entities: rest }] : [];
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const task = this.tasks.shift();
        if (!task) return;
        if (task.gen !== this.effectGeneration) continue;
        try {
          await this.runTask(task);
        } catch (e) {
          this.log.warn("effect batch failed:", e);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTask(task: EffectTask): Promise<void> {
    switch (task.kind) {
      case "setters":
        return this.runSetters(task.mode);
      case "alerts":
        return this.runAlerts(task.entities);
      case "silence":
        return this.runSilence(task.entities);
      case "reconnect":
        return this.flushAfterConnect();
    }
  }

  // Setter turn_on per domain: script.turn_on for script.*, scene.turn_on for
  // scene.*, else <domain>.turn_on. The intent goes to disk first and leaves
  // it only once every call resolved, so a crash, gap or failed call is
  // replayed on reconnect if the mode is still current.
  private async runSetters(key: ArmMode | "off"): Promise<void> {
    const entities = this.setters(key);
    if (entities.length === 0) return;
    const storage = this.context?.storage;
    await storage?.set(PENDING_SETTERS_KEY, { mode: key });
    await storage?.flush?.();
    if (this.connection?.connected !== true) {
      this.log.debug(
        `no Home Assistant connection, ${key} setters wait for the reconnect`,
      );
      return;
    }
    const ok = await this.callSequential(entities, "turn_on");
    if (ok) await storage?.delete(PENDING_SETTERS_KEY);
  }

  private async runAlerts(entityIds: string[]): Promise<void> {
    if (entityIds.length === 0) return;
    // Barrier: the triggered snapshot and alert set reach the disk before the
    // first turn_on, or a crash leaves a blaring siren with no recovery
    // intent.
    await this.context?.storage.flush?.();
    const connection = this.connection;
    if (!connection || !connection.connected) {
      this.log.warn(
        `no Home Assistant connection, alerts skipped: ${entityIds.join(",")}`,
      );
      return;
    }
    await this.callSequential(entityIds, "turn_on");
  }

  // Every due turn_off goes to storage first and leaves it only once HA
  // confirmed the call, so a crash or gap can never lose a silence.
  private async runSilence(entityIds: string[]): Promise<void> {
    const storage = this.context?.storage;
    if (storage && entityIds.length > 0) {
      const pending = (await storage.get<string[]>(PENDING_SILENCE_KEY)) ?? [];
      await storage.set(PENDING_SILENCE_KEY, [
        ...new Set([...pending, ...entityIds]),
      ]);
      await storage.flush?.();
    }
    await this.flushPendingSilence();
  }

  private async flushPendingSilence(): Promise<void> {
    const storage = this.context?.storage;
    if (!storage) return;
    let pending = (await storage.get<string[]>(PENDING_SILENCE_KEY)) ?? [];
    if (pending.length === 0) return;
    const connection = this.connection;
    if (!connection || !connection.connected) {
      this.log.warn(
        `no Home Assistant connection, silence stays pending for ${pending.join(",")}`,
      );
      return;
    }
    for (const entityId of [...pending]) {
      const domain = entityId.split(".")[0];
      try {
        await this.callWithDeadline(connection, domain, "turn_off", entityId);
        pending = pending.filter((id) => id !== entityId);
        await storage.set(PENDING_SILENCE_KEY, pending);
      } catch (e) {
        this.log.warn(
          `${domain}.turn_off failed for ${entityId}, retried on reconnect:`,
          e,
        );
      }
    }
    if (pending.length === 0) await storage.delete(PENDING_SILENCE_KEY);
  }

  // Ran after every (re)connect: sirens first, then any setter batch a gap
  // swallowed, but only if the machine still stands where it did.
  private async flushAfterConnect(): Promise<void> {
    if (this.sourceAlarmPanel()) {
      // A silence left pending from local-mode operation still has to run,
      // only the mode setters are void once a source panel owns the state.
      await this.flushPendingSilence();
      await this.context?.storage.delete(PENDING_SETTERS_KEY);
      await this.syncSourceAlarmState();
      return;
    }
    await this.flushPendingSilence();
    const storage = this.context?.storage;
    if (!storage) return;
    const held = await storage.get<{ mode: ArmMode | "off" }>(
      PENDING_SETTERS_KEY,
    );
    if (!held) return;
    const snap = this.machine?.snapshot;
    const stillCurrent =
      held.mode === "off"
        ? snap?.phase === "disarmed"
        : snap?.mode === held.mode && snap?.phase !== "disarmed";
    if (!stillCurrent) {
      await storage.delete(PENDING_SETTERS_KEY);
      return;
    }
    const ok = await this.callSequential(this.setters(held.mode), "turn_on");
    // The marker leaves storage only once every replacement call resolved.
    if (ok) await storage.delete(PENDING_SETTERS_KEY);
  }

  private async callSequential(
    entityIds: string[],
    service: "turn_on" | "turn_off",
  ): Promise<boolean> {
    const connection = this.connection;
    if (!connection || !connection.connected) return false;
    let allOk = true;
    for (const entityId of entityIds) {
      const domain = entityId.split(".")[0];
      try {
        await this.callWithDeadline(connection, domain, service, entityId);
      } catch (e) {
        allOk = false;
        this.log.warn(`${domain}.${service} failed for ${entityId}:`, e);
      }
    }
    return allOk;
  }

  private async callWithDeadline(
    connection: Connection,
    domain: string,
    service: string,
    entityId: string,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        callService(connection, domain, service, undefined, {
          entity_id: entityId,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${domain}.${service} for ${entityId} timed out after ${CALL_DEADLINE_MS}ms`,
                ),
              ),
            CALL_DEADLINE_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private startConnection(): void {
    const hasCustomUrl = !!this.config.haUrl;
    const hasCustomToken = !!this.config.haToken;
    if (hasCustomUrl !== hasCustomToken) {
      // Half a custom pair would dial a foreign server with the bridge token
      // or the bridge with a foreign token. Never mix the pairs.
      this.log.warn(
        "haUrl and haToken must both be set for a custom Home Assistant, using the bridge credentials instead",
      );
    }
    const custom = hasCustomUrl && hasCustomToken;
    const haUrl = custom ? this.config.haUrl : this.context?.homeAssistant?.url;
    const haToken = custom
      ? this.config.haToken
      : this.context?.homeAssistant?.accessToken;
    if (!haUrl || !haToken) {
      this.log.info(
        "no Home Assistant connection, setters, alerts and triggers stay inactive",
      );
      return;
    }
    void this.connect(haUrl, haToken);
  }

  private async connect(haUrl: string, haToken: string): Promise<void> {
    const generation = this.dialGeneration;
    let connection: Connection | undefined;
    try {
      connection = this.deps.connect
        ? await this.deps.connect(haUrl, haToken)
        : await createConnection({
            auth: createLongLivedTokenAuth(haUrl, haToken),
          });
      if (generation !== this.dialGeneration) {
        connection.close();
        return;
      }
      this.connection = connection;
      this.backoffMs = RETRY_BASE_MS;
      // Once established the hajs connection redials and resubscribes on its
      // own; our backoff below covers the initial dial.
      connection.addEventListener("disconnected", () =>
        this.log.info("Home Assistant connection lost, waiting for reconnect"),
      );
      connection.addEventListener("ready", () => this.enqueueReconnect());
      const unsubscribe = await connection.subscribeEvents(
        (event) => this.handleStateChanged(event as HaStateChangedEvent),
        "state_changed",
      );
      if (generation !== this.dialGeneration) {
        // stopConnection already closed this socket, the subscription died
        // with it.
        return;
      }
      this.unsubscribeEvents = unsubscribe;
      const source = this.sourceAlarmPanel();
      this.log.info(
        `watching ${this.watched.size} trigger entities` +
          (source ? ` and source alarm panel ${source}` : ""),
      );
      this.enqueueReconnect();
    } catch (e) {
      // Close the half-open socket before any retry.
      connection?.close();
      if (this.connection === connection) this.connection = undefined;
      if (generation !== this.dialGeneration) return;
      this.log.warn(
        `Home Assistant connection failed, retrying in ${this.backoffMs}ms:`,
        e,
      );
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, RETRY_MAX_MS);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (generation !== this.dialGeneration) return;
        void this.connect(haUrl, haToken);
      }, delay);
      this.retryTimer.unref?.();
    }
  }

  private async stopConnection(): Promise<void> {
    this.dialGeneration++;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const unsubscribe = this.unsubscribeEvents;
    this.unsubscribeEvents = undefined;
    if (unsubscribe) {
      try {
        await unsubscribe();
      } catch {
        // Subscription may already be gone with the socket.
      }
    }
    this.connection?.close();
    this.connection = undefined;
    this.backoffMs = RETRY_BASE_MS;
    if (this.sourceWriteReconcile) {
      clearTimeout(this.sourceWriteReconcile);
      this.sourceWriteReconcile = undefined;
    }
    // Invalidate in-flight source writes: a call resolving after this point
    // fails the token check and cannot revive a timer or clear a pending mode
    // that belongs to the next connection or source panel.
    this.pendingArmMode = null;
    this.sourceWriteSeq++;
  }

  private async syncSourceAlarmState(): Promise<void> {
    const source = this.sourceAlarmPanel();
    const connection = this.connection;
    if (!source || !connection?.connected) return;
    const generation = this.effectGeneration;
    const writeSeq = this.sourceWriteSeq;
    try {
      const states = await sendHaMessage<HassEntity[]>(
        connection,
        { type: "get_states" },
        CALL_DEADLINE_MS,
      );
      // A teardown or source change while the read was in flight makes the
      // response stale; applying it would overwrite the successor machine.
      // A write racing the read outranks it: the panel's answer to the write
      // or the reconcile timer will carry the newer truth.
      if (
        generation !== this.effectGeneration ||
        source !== this.sourceAlarmPanel() ||
        connection !== this.connection ||
        writeSeq !== this.sourceWriteSeq
      ) {
        return;
      }
      const sourceState = states.find((state) => state.entity_id === source);
      if (!sourceState) {
        this.log.warn(`source alarm panel ${source} was not found`);
        return;
      }
      await this.mirrorSourceAlarmState(source, sourceState.state);
    } catch (e) {
      this.log.warn(`failed to read source alarm panel ${source}:`, e);
    }
  }

  private async mirrorSourceAlarmState(
    entityId: string,
    state: string,
  ): Promise<void> {
    const observed = this.observedStateFromAlarmPanel(state);
    if (!observed) {
      this.log.debug(`source alarm panel ${entityId} state ignored: ${state}`);
      return;
    }
    // disarmed keeps the timer running: it may be a stale read racing an arm
    // write, and the timer is what clears the pending mode if nothing else
    // settles the write.
    if (this.sourceWriteReconcile && state !== "disarmed") {
      clearTimeout(this.sourceWriteReconcile);
      this.sourceWriteReconcile = undefined;
    }
    this.machine?.applyObservedState(observed);
    this.pushDeviceStates();
    await this.context?.storage.flush?.();
  }

  private observedStateFromAlarmPanel(
    state: string,
  ): ObservedSecurityState | undefined {
    switch (state) {
      case "disarmed":
        // Deliberately keeps pendingArmMode: a stale connect-time read can
        // deliver disarmed after an arm write; the arming event consumes the
        // pending mode, the reconcile timer clears an unconsumed one.
        return { mode: null, phase: "disarmed" };
      case "armed_home":
        this.pendingArmMode = null;
        return { mode: "home", phase: "armed" };
      case "armed_away":
        this.pendingArmMode = null;
        return { mode: "away", phase: "armed" };
      case "armed_night":
        this.pendingArmMode = null;
        return { mode: "night", phase: "armed" };
      case "armed_vacation":
        this.pendingArmMode = null;
        return { mode: "vacation", phase: "armed" };
      case "arming":
      case "pending": {
        // No mode on the wire during entry and exit delays; a Matter-initiated
        // arm knows the requested mode, keep that switch on instead of
        // collapsing to disarmed for the whole delay. Consumed on first use so
        // a keypad arm minutes later cannot inherit it; the machine snapshot
        // carries the mode across later phase-only updates.
        const pending = this.pendingArmMode;
        this.pendingArmMode = null;
        return pending ? { mode: pending, phase: state } : { phase: state };
      }
      case "triggered":
        return { phase: state };
      default:
        return undefined;
    }
  }

  private async handleSourceModeWrite(
    mode: ArmMode,
    on: boolean,
  ): Promise<void> {
    const source = this.sourceAlarmPanel();
    const connection = this.connection;
    if (!source || !connection?.connected) {
      this.log.warn(
        "source alarm panel write skipped, Home Assistant is not connected",
      );
      this.pushDeviceStates();
      return;
    }

    const snapshot = this.machine?.snapshot;
    // Off on the active mode disarms. A triggered panel with no known mode
    // (panic trigger, restart while triggered) must stay disarmable, so any
    // switch-off works there, same escape the local machine has.
    const service = on
      ? `alarm_arm_${mode}`
      : (snapshot?.mode === mode && snapshot.phase !== "disarmed") ||
          (snapshot?.mode == null && snapshot?.phase === "triggered")
        ? "alarm_disarm"
        : undefined;
    if (!service) {
      this.pushDeviceStates();
      return;
    }
    this.pendingArmMode = on ? mode : null;
    const token = ++this.sourceWriteSeq;

    try {
      await this.callWithDeadline(
        connection,
        "alarm_control_panel",
        service,
        source,
      );
      if (token !== this.sourceWriteSeq) return;
      // The call resolving proves nothing: HA answers success even when the
      // panel refuses (open sensor, missing entity) and then no state event
      // ever arrives. Reconcile to the snapshot unless an event lands first.
      if (this.sourceWriteReconcile) clearTimeout(this.sourceWriteReconcile);
      this.sourceWriteReconcile = setTimeout(() => {
        this.sourceWriteReconcile = undefined;
        if (token !== this.sourceWriteSeq) return;
        this.pendingArmMode = null;
        this.pushDeviceStates();
      }, SOURCE_WRITE_RECONCILE_MS);
    } catch (e) {
      this.log.warn(`${service} failed for source alarm panel ${source}:`, e);
      if (token !== this.sourceWriteSeq) return;
      this.pendingArmMode = null;
      this.pushDeviceStates();
    }
  }

  private handleStateChanged(event: HaStateChangedEvent): void {
    const entityId = event.data?.entity_id;
    const newState = event.data?.new_state;
    if (!entityId || !newState?.state) return;
    // state_changed also fires on attribute-only updates; only a real state
    // entry counts.
    if (event.data?.old_state?.state === newState.state) return;
    if (entityId === this.sourceAlarmPanel()) {
      void this.mirrorSourceAlarmState(entityId, newState.state);
      return;
    }
    this.handleTriggerEvent(
      entityId,
      newState.state,
      newState.attributes?.device_class,
    );
  }
}
