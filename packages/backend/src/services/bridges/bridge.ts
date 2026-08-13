import * as os from "node:os";
import {
  alexaPairingPortProblem,
  BridgeStatus,
  type ExposedDeviceType,
  type UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import type { Environment } from "@matter/general";
import { type Endpoint, Network } from "@matter/main";
import { CommissioningServer, InteractionServer } from "@matter/main/node";
import {
  DeviceAdvertiser,
  type Fabric,
  FabricManager,
  MdnsService,
  MessageType,
  SessionManager,
} from "@matter/main/protocol";
import { FilteredNetwork } from "../../core/app/filtered-network.js";
import type { BetterLogger, LoggerService } from "../../core/app/logger.js";
import { BridgeServerNode } from "../../matter/endpoints/bridge-server-node.js";
import {
  collectAdvertisedAddresses,
  runMdnsAddressWatchTick,
} from "../../matter/mdns-address-watch.js";
import {
  CAMERA_TCP_CONFIG,
  parseCameraList,
} from "../../plugins/builtin/camera/camera-tcp-requirement.js";
import type {
  PluginConfigSchema,
  PluginMetadata,
} from "../../plugins/types.js";
import { ensureCommissioningConfig } from "../../utils/ensure-commissioning-config.js";
import { isHeapUnderPressure, logMemoryUsage } from "../../utils/log-memory.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import type {
  BridgeDataProvider,
  BridgeServerStatus,
} from "./bridge-data-provider.js";
import type { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import {
  deadSessionTimeoutMs,
  PRIMING_GRACE_MS,
  parseSessionMaxAgeHours,
  ROTATION_CHECK_INTERVAL_MS,
  replacedSessionTimeoutMs,
  SESSION_MAX_AGE_HOURS_RANGE,
  seedExistingSessionStarts,
  selectSupersededSessions,
  staleSessionQuietWindowMs,
  staleSessionShouldClose,
} from "./session-rotation.js";
import {
  type SubscriptionSummary,
  summarizeSubscriptions,
} from "./subscription-summary.js";
import {
  countRecent,
  decideWedgeRotation,
  decideWedgeRotationV2,
  WEDGE_GIVE_UP_QUIET_MS,
  WEDGE_RING_SIZE,
} from "./wedge-watchdog.js";

// Marks an InteractionServer whose onNewExchange we already wrapped so re-wiring
// never stacks wrappers. A restart mints a fresh InteractionServer without the
// marker, so it gets wrapped again.
const imWrapMarker = Symbol("hamh.wedgeImWrap");

// First initiator messages that reach onNewExchange and mean the controller is
// actually consuming, not just re-subscribing. TimedRequest follow-ups ride
// the same exchange, so each type here is stamped exactly once per exchange.
const commandMessageTypes: number[] = [
  MessageType.ReadRequest,
  MessageType.WriteRequest,
  MessageType.InvokeRequest,
  MessageType.TimedRequest,
];

// Auto Force Sync interval in milliseconds (90 seconds).
// When autoForceSync is enabled, this pushes changed entity states to
// Matter controllers. matter.js handles subscription keepalive internally
// via empty DataReports every ~sendInterval.
const AUTO_FORCE_SYNC_INTERVAL_MS = 90_000;

// On shutdown, wait at most this long for active sessions to close cleanly.
// A clean close tells the controller to drop its CASE session right away
// instead of holding a stale one until its own timeout, which is what leaves
// a controller showing the bridge as unresponsive after a restart.
const SHUTDOWN_SESSION_CLOSE_TIMEOUT_MS = 2_500;

// How often to re-check the interface addresses mDNS advertises. A dynamic ISP
// IPv6 prefix change swaps the global address behind the cached operational
// records, so poll and re-announce when the set moves (#415).
const MDNS_ADDRESS_CHECK_INTERVAL_MS = 60_000;

export class Bridge {
  private readonly log: BetterLogger;
  readonly server: BridgeServerNode;

  private status: BridgeServerStatus = {
    code: BridgeStatus.Stopped,
    reason: undefined,
  };

  // Called whenever the bridge status changes. Set by BridgeService to
  // broadcast updates via WebSocket so the frontend sees every transition
  // (e.g. Stopped → Starting → Running).
  public onStatusChange?: () => void;

  private autoForceSyncTimer: ReturnType<typeof setInterval> | null = null;
  private deadSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private staleSessionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  // Age-based session rotation (#287): track when each session opened so an
  // aged controller session can be rotated, forcing it to re-subscribe.
  private sessionStartedAt = new Map<number, number>();
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private maxSessionAgeMs = 0;

  // Wedge watchdog: last inbound Interaction Model request time per session and
  // last time the watchdog rotated it, both keyed by the long-lived session
  // object so they clear when the session goes away.
  private lastImRequestAt = new WeakMap<object, number>();
  private wedgeLastRotatedAt = new WeakMap<object, number>();
  private wedgeWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // V2 shadow signals (#365): last command-class request per session, plus
  // rings of subscribe and delivery give-up times (newest WEDGE_RING_SIZE).
  private lastCommandImAt = new WeakMap<object, number>();
  private subscribeTimesMs = new WeakMap<object, number[]>();
  private giveUpTimesMs = new WeakMap<object, number[]>();
  // Sessions whose subscriptions.deleted we already hooked for give-ups.
  private wedgeHookedSessions = new WeakSet<object>();

  // Watches the advertised interface addresses so a dynamic ISP IPv6 prefix
  // change forces a fresh operational announcement (#415).
  private mdnsAddressTimer: ReturnType<typeof setInterval> | null = null;
  private advertisedAddressSnapshot: string[] = [];
  // Skip a tick while the previous one is still awaiting refresh, so a slow
  // refreshOperationalAdvertisement can't overlap and re-announce off a stale
  // snapshot.
  private mdnsCheckInFlight = false;

  // Serialize concurrent lifecycle calls so auto-recovery and a manual
  // restartBridge can't race past each other's Starting/Stopping states.
  private startInFlight?: Promise<void>;
  private stopInFlight?: Promise<void>;

  // Tracks the last synced state JSON per entity to avoid pushing unchanged states.
  // Key: entity_id, Value: JSON.stringify of entity.state
  private lastSyncedStates = new Map<string, string>();

  // Session lifecycle diagnostic handlers (non-destructive, logging only).
  // biome-ignore lint/suspicious/noExplicitAny: matter.js internal types
  private sessionDiagHandler?: (session: any, subscription: any) => void;
  // biome-ignore lint/suspicious/noExplicitAny: matter.js internal types
  private sessionAddedHandler?: (session: any) => void;
  // biome-ignore lint/suspicious/noExplicitAny: matter.js internal types
  private sessionDeletedHandler?: (session: any) => void;

  // Warns when Alexa pairs on a non-5540 port, the fabric rolls back later (#401).
  // biome-ignore lint/suspicious/noExplicitAny: matter.js internal types
  private fabricAddedHandler?: (fabric: any) => void;

  get id() {
    return this.dataProvider.id;
  }

  get data() {
    return this.dataProvider.withMetadata(
      this.status,
      this.server,
      this.aggregator.parts.size,
      this.endpointManager.failedEntities,
      this.getExposedDeviceTypes(),
    );
  }

  getSessionInfo(): {
    sessions: Array<{
      id: number;
      peerNodeId: string;
      fabricIndex: number | null;
      subscriptionCount: number;
      subscriptions: SubscriptionSummary[];
      lastActiveMsAgo: number | null;
      lastAnyActivityMsAgo: number | null;
      lastImRequestMsAgo: number | null;
      lastCommandImRequestMsAgo: number | null;
      subscribesLast30Min: number;
      giveUpsLast30Min: number;
      wedgeV2WouldRotate: boolean;
      isPeerActive: boolean;
      ageMsFromOpen: number | null;
    }>;
    totalSessions: number;
    totalSubscriptions: number;
    fabrics: Array<{
      fabricIndex: number;
      sessions: number;
      subscriptions: number;
    }>;
  } {
    try {
      const sessionManager = this.server.env.get(SessionManager);
      const sessions = [...sessionManager.sessions];
      let totalSubscriptions = 0;
      const fabricMap = new Map<
        number,
        { sessions: number; subscriptions: number }
      >();
      const sessionList = sessions.map((s) => {
        const subCount = s.subscriptions.size;
        totalSubscriptions += subCount;
        // Scope descriptor per subscription so the health view can tell a
        // whole-node wildcard from an endpoint-specific one (#365 class).
        const subscriptions = summarizeSubscriptions(s.subscriptions);
        const fi =
          typeof s.fabric?.fabricIndex === "number"
            ? s.fabric.fabricIndex
            : null;
        if (fi !== null) {
          const existing = fabricMap.get(fi) ?? {
            sessions: 0,
            subscriptions: 0,
          };
          existing.sessions++;
          existing.subscriptions += subCount;
          fabricMap.set(fi, existing);
        }
        // #365: per-session liveness so a wedged subscription (counted alive
        // but the controller stopped processing) can be told from a healthy
        // one. activeTimestamp advances only on inbound from the peer.
        const nowMs = Date.now();
        const lastActiveMsAgo =
          typeof s.activeTimestamp === "number" && s.activeTimestamp > 0
            ? nowMs - s.activeTimestamp
            : null;
        const lastAnyActivityMsAgo =
          typeof s.timestamp === "number" ? nowMs - s.timestamp : null;
        const lastImAt = this.lastImRequestAt.get(s);
        const lastImRequestMsAgo = lastImAt != null ? nowMs - lastImAt : null;
        const startedAt = this.sessionStartedAt.get(s.id);
        // V2 shadow signals (#365): command silence, subscribe/give-up churn
        // and what the v2 rule would decide right now.
        const lastCmdAt = this.lastCommandImAt.get(s);
        const lastCommandImRequestMsAgo =
          lastCmdAt != null ? nowMs - lastCmdAt : null;
        const subscribeTimes = this.subscribeTimesMs.get(s) ?? [];
        const giveUpTimes = this.giveUpTimesMs.get(s) ?? [];
        const lastRotatedAt = this.wedgeLastRotatedAt.get(s);
        const wedgeV2WouldRotate = decideWedgeRotationV2({
          subscriptionCount: subCount,
          sessionAgeMs: startedAt != null ? nowMs - startedAt : 0,
          commandSilenceMs: lastCommandImRequestMsAgo,
          subscribeTimesMs: subscribeTimes,
          giveUpTimesMs: giveUpTimes,
          nowMs,
          lastRotatedMsAgo:
            lastRotatedAt != null ? nowMs - lastRotatedAt : null,
        });
        return {
          id: s.id,
          peerNodeId: String(s.peerNodeId),
          fabricIndex: fi,
          subscriptionCount: subCount,
          subscriptions,
          lastActiveMsAgo,
          lastAnyActivityMsAgo,
          lastImRequestMsAgo,
          lastCommandImRequestMsAgo,
          subscribesLast30Min: countRecent(subscribeTimes, nowMs),
          giveUpsLast30Min: countRecent(giveUpTimes, nowMs),
          wedgeV2WouldRotate,
          isPeerActive: Boolean(s.isPeerActive),
          ageMsFromOpen: startedAt != null ? nowMs - startedAt : null,
        };
      });
      const fabrics = [...fabricMap.entries()].map(([fabricIndex, data]) => ({
        fabricIndex,
        sessions: data.sessions,
        subscriptions: data.subscriptions,
      }));
      return {
        sessions: sessionList,
        totalSessions: sessions.length,
        totalSubscriptions,
        fabrics,
      };
    } catch {
      return {
        sessions: [],
        totalSessions: 0,
        totalSubscriptions: 0,
        fabrics: [],
      };
    }
  }

  get aggregator() {
    return this.endpointManager.root;
  }

  /**
   * The entity id and numeric Matter device type of every exposed endpoint,
   * walking composed sub-endpoints. Used to warn when a device type is not
   * supported by a commissioned controller (#365 class).
   */
  getExposedDeviceTypes(): ExposedDeviceType[] {
    const out: ExposedDeviceType[] = [];
    const collect = (ep: Endpoint, inheritedEntityId?: string) => {
      const entityId =
        (ep as { entityId?: string }).entityId ?? inheritedEntityId;
      const deviceTypeId = ep.type?.deviceType;
      if (typeof deviceTypeId === "number" && entityId) {
        out.push({ entityId, deviceTypeId });
      }
      for (const child of ep.parts) {
        collect(child, entityId);
      }
    };
    for (const ep of this.aggregator.parts) {
      collect(ep);
    }
    return out;
  }

  get pluginInfo() {
    return this.endpointManager.getPluginInfo();
  }

  async enablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.endpointManager.enablePlugin(pluginName);
  }

  async disablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.endpointManager.disablePlugin(pluginName);
  }

  resetPlugin(pluginName: string): void {
    this.endpointManager.resetPlugin(pluginName);
  }

  getPluginConfigSchema(pluginName: string): PluginConfigSchema | undefined {
    return this.endpointManager.getPluginConfigSchema(pluginName);
  }

  async updatePluginConfig(
    pluginName: string,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.endpointManager.updatePluginConfig(
      pluginName,
      config,
    );
    // only when the save actually landed, else tcp state drifts from storage
    if (result && pluginName === "camera") {
      await this.applyCameraTcp(config);
    }
    return result;
  }

  // #419: cameras need Matter over TCP because the WebRTC offer exceeds the UDP
  // message size. Match the bridge listener to the saved camera list. Changing
  // network config takes effect on (re)start, so bounce the bridge if running.
  private async applyCameraTcp(config: Record<string, unknown>): Promise<void> {
    const want = parseCameraList(config.cameras).length > 0;
    const have = !!this.server.state.network.tcp;
    if (want === have) {
      return;
    }
    this.log.info(
      want
        ? "cameras configured, enabling matter over tcp (#419)"
        : "no cameras left, disabling matter over tcp (#419)",
    );
    const running = this.status.code === BridgeStatus.Running;
    if (running) {
      await this.stop();
    }
    try {
      await this.server.set({
        network: { tcp: want ? CAMERA_TCP_CONFIG : undefined },
      });
    } catch (e) {
      this.log.warn(
        "Could not apply tcp live, restart matterhub to apply it:",
        e,
      );
    }
    if (running) {
      await this.start();
    }
  }

  constructor(
    env: Environment,
    logger: LoggerService,
    private readonly dataProvider: BridgeDataProvider,
    private readonly endpointManager: BridgeEndpointManager,
    private readonly serverOptions?: {
      tcp?: { incoming: boolean; outgoing: boolean };
    },
  ) {
    this.log = logger.get(`Bridge / ${dataProvider.id}`);
    this.server = new BridgeServerNode(
      env,
      this.dataProvider,
      this.endpointManager.root,
      this.serverOptions,
    );
    const { basicInformation } = this.dataProvider;
    this.log.debugCtx("Root bridge BasicInformation configured", {
      vendorName: basicInformation.vendorName,
      productName: basicInformation.productName,
      productLabel: basicInformation.productLabel,
      hardwareVersion: basicInformation.hardwareVersion,
      hardwareVersionString: basicInformation.hardwareVersionString,
      softwareVersion: basicInformation.softwareVersion,
      softwareVersionString: basicInformation.softwareVersionString,
    });
  }

  async initialize(): Promise<void> {
    await this.server.construction.ready.then();
    await this.refreshDevices();
  }
  async dispose(): Promise<void> {
    await this.stop();
  }

  async refreshDevices() {
    await this.endpointManager.refreshDevices();
    // Prune stale entries from lastSyncedStates for entities that were removed
    const currentEntityIds = new Set(
      [...this.aggregator.parts].map(
        (p) => (p as { entityId?: string }).entityId,
      ),
    );
    for (const entityId of this.lastSyncedStates.keys()) {
      if (!currentEntityIds.has(entityId)) {
        this.lastSyncedStates.delete(entityId);
      }
    }
  }

  private setStatus(status: BridgeServerStatus) {
    this.status = status;
    this.onStatusChange?.();
  }

  async start() {
    if (this.status.code === BridgeStatus.Running) {
      return;
    }
    if (this.startInFlight) {
      return this.startInFlight;
    }
    this.startInFlight = this.runStart().finally(() => {
      this.startInFlight = undefined;
    });
    return this.startInFlight;
  }

  private async runStart() {
    this.lastSyncedStates.clear();
    try {
      this.setStatus({
        code: BridgeStatus.Starting,
        reason: "The bridge is starting... Please wait.",
      });
      await this.refreshDevices();
      logMemoryUsage(
        this.log,
        `after refreshDevices (${this.aggregator.parts.size} endpoints)`,
      );
      this.endpointManager.startObserving();
      ensureCommissioningConfig(this.server);
      await this.server.start();
      await this.endpointManager.startPlugins();
      this.setStatus({ code: BridgeStatus.Running });
      this.startAutoForceSyncIfEnabled();

      // Force sync immediately on startup to push current HA state to controllers
      // before they reconnect and execute any queued commands
      if (this.dataProvider.featureFlags?.autoForceSync) {
        this.forceSync().catch((e) => {
          this.log.warn("Startup force sync failed:", e);
        });
      }

      this.wireSessionDiagnostics();
      this.wireFabricWarnings();
      this.startSessionRotation();
      this.startWedgeWatchdog();
      this.startMdnsAddressWatch();
      logMemoryUsage(this.log, "bridge running");
      diagnosticEventBus.emit("bridge_started", `Bridge started`, {
        bridgeId: this.id,
        bridgeName: this.dataProvider.name,
        details: { deviceCount: this.aggregator.parts.size },
      });
    } catch (e) {
      const reason = "Failed to start bridge due to error:";
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  async stop(
    code: BridgeStatus = BridgeStatus.Stopped,
    reason = "Manually stopped",
  ) {
    if (this.stopInFlight) {
      return this.stopInFlight;
    }
    this.stopInFlight = this.runStop(code, reason).finally(() => {
      this.stopInFlight = undefined;
    });
    return this.stopInFlight;
  }

  private async runStop(code: BridgeStatus, reason: string) {
    this.unwireSessionDiagnostics();
    this.unwireFabricWarnings();
    this.stopAutoForceSync();
    await this.closeActiveSessions();
    await this.endpointManager.stopPlugins();
    this.endpointManager.stopObserving();
    try {
      await this.server.cancel();
    } catch (e) {
      // Ignore mutex-closed errors during shutdown - this is expected
      // when the environment is being disposed
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (!errorMessage.includes("mutex-closed")) {
        this.log.warn("Error stopping bridge server:", e);
      }
    }
    this.setStatus({ code, reason });
    diagnosticEventBus.emit("bridge_stopped", `Bridge stopped: ${reason}`, {
      bridgeId: this.id,
      bridgeName: this.dataProvider.name,
    });
  }

  private startAutoForceSyncIfEnabled() {
    // Stop any existing timer first
    this.stopAutoForceSync();

    const forceSyncEnabled =
      this.dataProvider.featureFlags?.autoForceSync ?? false;

    if (!forceSyncEnabled) {
      return;
    }

    // Force sync pushes changed entity states to Matter controllers.
    // matter.js handles subscription keepalive internally via empty DataReports.
    this.autoForceSyncTimer = setInterval(() => {
      this.forceSync().catch((e) => {
        this.log.warn("Auto force sync failed:", e);
      });
    }, AUTO_FORCE_SYNC_INTERVAL_MS);

    this.log.info(`Force sync: every ${AUTO_FORCE_SYNC_INTERVAL_MS / 1000}s`);
  }

  private wireSessionDiagnostics() {
    // Drop any existing listener first. Factory reset restarts the bridge
    // without going through stop(), so without this the old handler leaks and
    // every session close is logged twice.
    this.unwireSessionDiagnostics();
    try {
      const sessionManager = this.server.env.get(SessionManager);
      seedExistingSessionStarts(this.sessionStartedAt, sessionManager.sessions);
      const hookGiveUpsWithPeers = (sess: {
        peerNodeId?: unknown;
        fabric?: { fabricIndex?: unknown };
        subscriptions?: {
          deleted?: { on?: (fn: (sub: unknown) => void) => void };
        };
      }) =>
        this.hookSubscriptionGiveUps(sess, () =>
          [...sessionManager.sessions].filter(
            (s) =>
              s.peerNodeId === sess.peerNodeId &&
              s.fabric?.fabricIndex === sess.fabric?.fabricIndex,
          ),
        );
      // Sessions alive before the wire (controller connected during startup)
      // must be watched too, the added event already fired without us.
      for (const sess of sessionManager.sessions) {
        hookGiveUpsWithPeers(sess);
      }
      this.sessionDiagHandler = (session: {
        id: number;
        peerNodeId: unknown;
        subscriptions: { size: number };
      }) => {
        const sessions = [...sessionManager.sessions];
        let totalSubs = 0;
        for (const s of sessions) {
          totalSubs += s.subscriptions.size;
        }
        this.log.debug(
          `Session ${session.id} (peer ${session.peerNodeId}): subscriptions=${session.subscriptions.size} | total: sessions=${sessions.length} subscriptions=${totalSubs}`,
        );
        diagnosticEventBus.emit(
          "subscription_changed",
          `Session ${session.id}: ${session.subscriptions.size} subs (total ${totalSubs})`,
          {
            bridgeId: this.data.id,
            bridgeName: this.data.name,
            details: {
              sessionId: session.id,
              sessionSubs: session.subscriptions.size,
              totalSessions: sessions.length,
              totalSubs,
            },
          },
        );
        if (totalSubs === 0 && sessions.length > 0) {
          this.log.warn(
            `All subscriptions lost, ${sessions.length} session(s) still active, waiting for controller to re-subscribe`,
          );
          if (!this.deadSessionTimer) {
            const timeoutMs = deadSessionTimeoutMs(
              this.dataProvider.featureFlags,
            );
            this.deadSessionTimer = setTimeout(() => {
              this.deadSessionTimer = null;
              this.closeDeadSessions();
            }, timeoutMs);
            this.log.info(
              `Scheduled dead session cleanup in ${timeoutMs / 1000}s`,
            );
          }
        } else if (totalSubs > 0 && this.deadSessionTimer) {
          clearTimeout(this.deadSessionTimer);
          this.deadSessionTimer = null;
          this.log.info(
            "Subscriptions recovered, canceled dead session cleanup",
          );
        }

        // Per-session stale tracking: schedule cleanup for individual
        // sessions that lose all subscriptions even when the bridge
        // as a whole still has active subscriptions from other peers.
        if (
          session.subscriptions.size === 0 &&
          !this.staleSessionTimers.has(session.id)
        ) {
          this.staleSessionTimers.set(
            session.id,
            setTimeout(() => {
              this.staleSessionTimers.delete(session.id);
              this.closeStaleSession(session.id);
            }, deadSessionTimeoutMs(this.dataProvider.featureFlags)),
          );
        } else if (
          session.subscriptions.size > 0 &&
          this.staleSessionTimers.has(session.id)
        ) {
          clearTimeout(this.staleSessionTimers.get(session.id)!);
          this.staleSessionTimers.delete(session.id);
        }
      };
      sessionManager.subscriptionsChanged.on(this.sessionDiagHandler);

      this.sessionAddedHandler = (newSession: {
        id: number;
        peerNodeId: unknown;
        fabric?: { fabricIndex: unknown };
        subscriptions?: {
          deleted?: { on?: (fn: (sub: unknown) => void) => void };
        };
      }) => {
        this.sessionStartedAt.set(newSession.id, Date.now());
        hookGiveUpsWithPeers(newSession);
        this.log.info(
          `Session opened: id=${newSession.id} peer=${newSession.peerNodeId}`,
        );
        diagnosticEventBus.emit(
          "session_opened",
          `Session ${newSession.id} opened (peer ${newSession.peerNodeId})`,
          {
            bridgeId: this.data.id,
            bridgeName: this.data.name,
            details: { sessionId: newSession.id },
          },
        );
        // Clean up stale sessions from the same peer that have lost all
        // subscriptions. matter.js 0.16.10 CaseServer does not close
        // previous sessions when establishing a new CASE session, causing
        // unbounded session accumulation over time (#105).
        for (const s of [...sessionManager.sessions]) {
          if (
            s !== newSession &&
            !s.isClosing &&
            s.peerNodeId === newSession.peerNodeId &&
            s.fabric?.fabricIndex === newSession.fabric?.fabricIndex &&
            s.subscriptions.size === 0
          ) {
            // A subscription only counts once its priming report finished,
            // so closing here would abort a controller mid-interview. Hand
            // the session to the stale timer instead: it keeps anything that
            // gained subscriptions and still closes a dead one.
            this.log.info(
              `Session ${s.id} (peer ${s.peerNodeId}, 0 subs) replaced by session ${newSession.id}, closing it once it goes quiet`,
            );
            // Replace any shorter timer armed earlier, it would fire mid
            // priming.
            const staleId = s.id;
            const armed = this.staleSessionTimers.get(staleId);
            if (armed) clearTimeout(armed);
            this.staleSessionTimers.set(
              staleId,
              setTimeout(() => {
                this.staleSessionTimers.delete(staleId);
                // keep the priming floor across re-arms
                this.closeStaleSession(staleId, PRIMING_GRACE_MS);
              }, replacedSessionTimeoutMs(this.dataProvider.featureFlags)),
            );
          }
        }
        // Sweep superseded sessions the #105 loop cannot: same peer+fabric
        // sessions still holding a dead subscription escaped every cleanup
        // path and piled up 160 deep for one flapping Echo (#400). The
        // selector also returns the 0-sub ones the loop above just handled,
        // so skip those here.
        const quietWindowMs = staleSessionQuietWindowMs(
          this.dataProvider.featureFlags,
        );
        const now = Date.now();
        const supersededIds = new Set(
          selectSupersededSessions(
            [...sessionManager.sessions],
            newSession,
            quietWindowMs,
            now,
          ),
        );
        const closes: Promise<unknown>[] = [];
        for (const s of [...sessionManager.sessions]) {
          if (!supersededIds.has(s.id) || s.subscriptions.size === 0) continue;
          const quietSec = Math.round((now - s.timestamp) / 1000);
          this.log.info(
            `Closing superseded session ${s.id} (peer ${s.peerNodeId}, ${s.subscriptions.size} subs, quiet ${quietSec}s), replaced by session ${newSession.id}`,
          );
          closes.push(
            s.initiateClose().catch(() =>
              s.initiateForceClose({
                cause: new Error("superseded session, forcing"),
              }),
            ),
          );
        }
        if (closes.length > 0) {
          Promise.allSettled(closes).then(() => this.triggerMdnsReAnnounce());
        }
      };
      this.sessionDeletedHandler = (session: {
        id: number;
        peerNodeId: unknown;
      }) => {
        this.sessionStartedAt.delete(session.id);
        // its timer has nothing left to close
        const armed = this.staleSessionTimers.get(session.id);
        if (armed) {
          clearTimeout(armed);
          this.staleSessionTimers.delete(session.id);
        }
        const sessions = [...sessionManager.sessions];
        this.log.warn(
          `Session closed: id=${session.id} peer=${session.peerNodeId} | remaining sessions=${sessions.length}`,
        );
        diagnosticEventBus.emit(
          "session_closed",
          `Session ${session.id} closed (peer ${session.peerNodeId})`,
          {
            bridgeId: this.data.id,
            bridgeName: this.data.name,
            details: {
              sessionId: session.id,
              remainingSessions: sessions.length,
            },
          },
        );
      };
      sessionManager.sessions.added.on(this.sessionAddedHandler);
      sessionManager.sessions.deleted.on(this.sessionDeletedHandler);
      this.wireImRequestTracking();
    } catch {
      // SessionManager not yet available
    }
  }

  // Stamp the time of every inbound Interaction Model request per session by
  // wrapping InteractionServer.onNewExchange. The wedge watchdog reads these to
  // tell a live-but-consuming controller from one that only keeps acking.
  private wireImRequestTracking() {
    try {
      const is = this.server.env.get(InteractionServer);
      const marked = is as unknown as Record<symbol, unknown>;
      if (marked[imWrapMarker]) {
        return;
      }
      const original = is.onNewExchange.bind(is);
      is.onNewExchange = (exchange, message) => {
        const session = exchange.session;
        if (session) {
          const now = Date.now();
          this.lastImRequestAt.set(session, now);
          const type = message?.payloadHeader?.messageType;
          if (type === MessageType.SubscribeRequest) {
            this.pushWedgeRing(this.subscribeTimesMs, session, now);
          } else if (type != null && commandMessageTypes.includes(type)) {
            this.lastCommandImAt.set(session, now);
          }
        }
        return original(exchange, message);
      };
      marked[imWrapMarker] = true;
    } catch {
      // InteractionServer not yet available
    }
  }

  // Keep only the newest WEDGE_RING_SIZE timestamps per session.
  private pushWedgeRing(
    ring: WeakMap<object, number[]>,
    session: object,
    now: number,
  ) {
    const times = ring.get(session) ?? [];
    times.push(now);
    if (times.length > WEDGE_RING_SIZE) {
      times.splice(0, times.length - WEDGE_RING_SIZE);
    }
    ring.set(session, times);
  }

  // Watch this session's subscriptions for server-side delivery give-ups
  // (#365 v2 shadow). isTerminated true fires both on a peer cancel and on
  // the 3-strikes delivery give-up; only the give-up arrives without a
  // coincident inbound IM request, so that is the discriminator.
  private hookSubscriptionGiveUps(
    session: {
      subscriptions?: {
        deleted?: { on?: (fn: (sub: unknown) => void) => void };
      };
    },
    peerSessions?: () => Iterable<object>,
  ) {
    const key = session as object;
    if (this.wedgeHookedSessions.has(key)) {
      return;
    }
    const deleted = session.subscriptions?.deleted;
    if (typeof deleted?.on !== "function") {
      return;
    }
    this.wedgeHookedSessions.add(key);
    deleted.on((sub) => {
      if ((sub as { isTerminated?: boolean })?.isTerminated !== true) {
        return;
      }
      const now = Date.now();
      const fresh = (s: object) => {
        const at = this.lastImRequestAt.get(s);
        return at != null && now - at <= WEDGE_GIVE_UP_QUIET_MS;
      };
      // Fresh inbound alongside the termination: a peer cancel, not a
      // give-up. keepSubscriptions=false on a sibling session cancels this
      // session's subs too and stamps only the sibling, so the whole peer
      // has to be quiet before this counts.
      if (fresh(key)) {
        return;
      }
      for (const s of peerSessions?.() ?? []) {
        if (s !== key && fresh(s)) {
          return;
        }
      }
      this.pushWedgeRing(this.giveUpTimesMs, key, now);
      // Cross-checkable against matter.js "Giving up on subscription" notices:
      // a recorded give-up WITHOUT that notice was an InvalidSubscription or
      // Failure answer from a live controller, not a delivery give-up.
      this.log.debug(
        `wedge v2 give-up recorded sub=${(sub as { subscriptionId?: number })?.subscriptionId}`,
      );
    });
  }

  private closeStaleSession(sessionId: number, minQuietMs = 0) {
    try {
      const sessionManager = this.server.env.get(SessionManager);
      for (const s of [...sessionManager.sessions]) {
        if (s.id !== sessionId || s.isClosing || s.subscriptions.size > 0) {
          continue;
        }
        const idleSec = Math.round((Date.now() - s.timestamp) / 1000);
        if (
          !staleSessionShouldClose(
            s,
            Math.max(
              staleSessionQuietWindowMs(this.dataProvider.featureFlags),
              minQuietMs,
            ),
          )
        ) {
          // 0 subs but recent traffic: the peer is recovering, not dead.
          // Re-arm and only close once it goes quiet, so a controller can
          // re-subscribe on this session instead of being forced offline (#287/#398).
          this.log.info(
            `Keeping session ${s.id} (peer ${s.peerNodeId}, 0 subs, last traffic ${idleSec}s ago)`,
          );
          this.staleSessionTimers.set(
            sessionId,
            setTimeout(() => {
              this.staleSessionTimers.delete(sessionId);
              // carry the floor, or the re-arm drops back to no quiet window
              this.closeStaleSession(sessionId, minQuietMs);
            }, deadSessionTimeoutMs(this.dataProvider.featureFlags)),
          );
          break;
        }
        this.log.warn(
          `Closing stale session ${s.id} (peer ${s.peerNodeId}, no subscriptions for ${deadSessionTimeoutMs(this.dataProvider.featureFlags) / 1000}s, no traffic for ${idleSec}s)`,
        );
        s.initiateClose()
          .catch(() => {
            // Graceful close failed (peer unreachable), force-close locally
            return s.initiateForceClose({
              cause: new Error("graceful close failed, forcing"),
            });
          })
          .catch(() => {})
          .finally(() => this.triggerMdnsReAnnounce());
        break;
      }
    } catch {
      // SessionManager may be disposed
    }
  }

  private closeDeadSessions() {
    try {
      const sessionManager = this.server.env.get(SessionManager);
      const sessions = [...sessionManager.sessions];
      const closes: Promise<void>[] = [];
      let kept = 0;
      for (const s of sessions) {
        if (s.isClosing || s.subscriptions.size > 0) {
          continue;
        }
        // A per-session timer already owns this one, and it may be priming
        // right now, which shows as 0 subscriptions (#424).
        if (this.staleSessionTimers.has(s.id)) {
          continue;
        }
        const idleSec = Math.round((Date.now() - s.timestamp) / 1000);
        if (
          !staleSessionShouldClose(
            s,
            staleSessionQuietWindowMs(this.dataProvider.featureFlags),
          )
        ) {
          // Recent traffic: leave it so the peer can re-subscribe (#287/#398).
          this.log.info(
            `Keeping session ${s.id} (peer ${s.peerNodeId}, 0 subs, last traffic ${idleSec}s ago)`,
          );
          kept++;
          continue;
        }
        this.log.warn(
          `Closing dead session ${s.id} (peer ${s.peerNodeId}, no subscriptions for ${deadSessionTimeoutMs(this.dataProvider.featureFlags) / 1000}s, no traffic for ${idleSec}s)`,
        );
        closes.push(
          s.initiateClose().catch(() => {
            // Graceful close failed (peer unreachable), force-close locally
            return s.initiateForceClose({
              cause: new Error("graceful close failed, forcing"),
            });
          }),
        );
      }
      if (closes.length > 0) {
        Promise.allSettled(closes).then(() => this.triggerMdnsReAnnounce());
      }
      if (kept > 0 && !this.deadSessionTimer) {
        // Some peers are still active; re-check after another interval.
        this.deadSessionTimer = setTimeout(() => {
          this.deadSessionTimer = null;
          this.closeDeadSessions();
        }, deadSessionTimeoutMs(this.dataProvider.featureFlags));
      }
    } catch {
      // SessionManager may be disposed
    }
  }

  // Close every active session on shutdown so each controller is told to drop
  // its CASE session instead of being left with a stale one. Mirrors the
  // dead-session close, but covers all sessions and waits (capped) so the
  // close actually reaches the peer before the server is canceled.
  private async closeActiveSessions() {
    try {
      const sessionManager = this.server.env.get(SessionManager);
      const closes: Promise<void>[] = [];
      for (const s of [...sessionManager.sessions]) {
        if (s.isClosing) {
          continue;
        }
        closes.push(
          s.initiateClose().catch(() => {
            // Graceful close failed (peer unreachable), force-close locally
            return s.initiateForceClose({
              cause: new Error("graceful close failed, forcing"),
            });
          }),
        );
      }
      if (closes.length === 0) {
        return;
      }
      this.log.info(`Closing ${closes.length} active session(s) on shutdown`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_SESSION_CLOSE_TIMEOUT_MS);
      });
      try {
        await Promise.race([Promise.allSettled(closes), timeout]);
      } finally {
        // Clear the timer so it can't keep the event loop alive once the
        // closes settle first.
        clearTimeout(timer);
      }
    } catch {
      // SessionManager may be disposed
    }
  }

  /**
   * Force a fresh mDNS operational advertisement after session cleanup.
   * matter.js DeviceAdvertiser only re-announces when a subscription is
   * canceled BY THE PEER. When the server cancels after 3 delivery
   * timeouts, no re-announcement happens and the controller may not
   * realize it should reconnect (#266).
   */
  private triggerMdnsReAnnounce() {
    try {
      const advertiser = this.server.env.get(DeviceAdvertiser);
      // restartAdvertisement re-sends the cached records for live fabrics but
      // does not rebuild them; refreshOperationalAdvertisement (used by the
      // address watch for #415) is what re-runs the address lookup. This path
      // only needs the controller poked to reconnect, so keep it as is.
      advertiser.restartAdvertisement();
      this.log.info("Triggered mDNS re-announcement after session cleanup");
    } catch {
      // DeviceAdvertiser may not be available
    }
  }

  private unwireSessionDiagnostics() {
    try {
      const sessionManager = this.server.env.get(SessionManager);
      if (this.sessionDiagHandler) {
        sessionManager.subscriptionsChanged.off(this.sessionDiagHandler);
      }
      if (this.sessionAddedHandler) {
        sessionManager.sessions.added.off(this.sessionAddedHandler);
      }
      if (this.sessionDeletedHandler) {
        sessionManager.sessions.deleted.off(this.sessionDeletedHandler);
      }
    } catch {
      // Already disposed
    }
    this.sessionDiagHandler = undefined;
    this.sessionAddedHandler = undefined;
    this.sessionDeletedHandler = undefined;
    if (this.deadSessionTimer) {
      clearTimeout(this.deadSessionTimer);
      this.deadSessionTimer = null;
    }
    for (const timer of this.staleSessionTimers.values()) {
      clearTimeout(timer);
    }
    this.staleSessionTimers.clear();
    this.stopSessionRotation();
    this.stopWedgeWatchdog();
    this.stopMdnsAddressWatch();
    this.sessionStartedAt.clear();
  }

  // Warn at the fabric-added event when Alexa pairs on a non-5540 port. Alexa
  // completes AddNOC but never CASEs, so the fabric rolls back on failsafe
  // expiry ~20s later and the committed-fabric warning path never sees it (#401).
  private wireFabricWarnings() {
    // Drop the old listener first so factory-reset restarts do not double-register.
    this.unwireFabricWarnings();
    try {
      const fabrics = this.server.env.get(FabricManager);
      this.fabricAddedHandler = (fabric: { rootVendorId: number }) => {
        const port = this.dataProvider.port;
        if (alexaPairingPortProblem(fabric.rootVendorId, port)) {
          this.log.warn(
            `Fabric added by Amazon Alexa (vendor ${fabric.rootVendorId}) on port ${port}. Alexa only completes pairing on port 5540, this attempt will roll back about 20s after AddNOC. Recreate the bridge on port 5540 (#401)`,
          );
        }
      };
      fabrics.events.added.on(this.fabricAddedHandler);
    } catch {
      // FabricManager not yet available
    }
  }

  private unwireFabricWarnings() {
    try {
      const fabrics = this.server.env.get(FabricManager);
      if (this.fabricAddedHandler) {
        fabrics.events.added.off(this.fabricAddedHandler);
      }
    } catch {
      // Already disposed
    }
    this.fabricAddedHandler = undefined;
  }

  private stopAutoForceSync() {
    if (this.autoForceSyncTimer) {
      clearInterval(this.autoForceSyncTimer);
      this.autoForceSyncTimer = null;
    }
  }

  // Start periodic age-based session rotation (#287). Aging out a controller's
  // session forces it to re-establish and re-subscribe, recovering a wedged
  // Alexa subscription that would otherwise stay stuck until a restart.
  private startSessionRotation() {
    this.stopSessionRotation();
    const hours = this.readSessionMaxAgeHours();
    if (hours === 0) {
      this.log.info(
        "Session rotation disabled (HAMH_MATTER_SESSION_MAX_AGE_HOURS=0)",
      );
      return;
    }
    this.maxSessionAgeMs = hours * 60 * 60 * 1000;
    this.rotationTimer = setInterval(
      () => this.rotateAgedSessions(),
      ROTATION_CHECK_INTERVAL_MS,
    );
    this.log.info(
      `Session rotation: max age ${hours}h, check every ${ROTATION_CHECK_INTERVAL_MS / 60_000}min`,
    );
  }

  private stopSessionRotation() {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  // Opt-in wedge watchdog: reuse the rotation check cadence (5min) to look for
  // the one session wedged on "Updating" and rotate just that one.
  private startWedgeWatchdog() {
    this.stopWedgeWatchdog();
    if (!this.dataProvider.featureFlags?.wedgeWatchdog) {
      return;
    }
    this.wedgeWatchdogTimer = setInterval(
      () => this.runWedgeWatchdogCheck(),
      ROTATION_CHECK_INTERVAL_MS,
    );
    this.log.info(
      `Wedge watchdog: checking every ${ROTATION_CHECK_INTERVAL_MS / 60_000}min`,
    );
  }

  private stopWedgeWatchdog() {
    if (this.wedgeWatchdogTimer) {
      clearInterval(this.wedgeWatchdogTimer);
      this.wedgeWatchdogTimer = null;
    }
  }

  // Rotate exactly the sessions the pure rule flags as wedged. Closing is the
  // same graceful-then-force path age rotation uses, so a false positive just
  // re-CASEs the controller.
  private runWedgeWatchdogCheck() {
    try {
      const sessionManager = this.server.env.get(SessionManager);
      const now = Date.now();
      const closes: Promise<void>[] = [];
      for (const s of [...sessionManager.sessions]) {
        if (s.isClosing) continue;
        const startedAt = this.sessionStartedAt.get(s.id);
        const sessionAgeMs = startedAt != null ? now - startedAt : 0;
        const lastImAt = this.lastImRequestAt.get(s);
        const lastImRequestMsAgo = lastImAt != null ? now - lastImAt : null;
        const lastRotatedAt = this.wedgeLastRotatedAt.get(s);
        const lastRotatedMsAgo =
          lastRotatedAt != null ? now - lastRotatedAt : null;
        const v1 = decideWedgeRotation({
          subscriptionCount: s.subscriptions.size,
          sessionAgeMs,
          lastImRequestMsAgo,
          lastRotatedMsAgo,
        });
        // V2 shadow (#365): evaluate and log only, so the soak can compare
        // both rules before v2 is allowed to close anything.
        const lastCmdAt = this.lastCommandImAt.get(s);
        const commandSilenceMs = lastCmdAt != null ? now - lastCmdAt : null;
        const subscribeTimes = this.subscribeTimesMs.get(s) ?? [];
        const giveUpTimes = this.giveUpTimesMs.get(s) ?? [];
        const v2 = decideWedgeRotationV2({
          subscriptionCount: s.subscriptions.size,
          sessionAgeMs,
          commandSilenceMs,
          subscribeTimesMs: subscribeTimes,
          giveUpTimesMs: giveUpTimes,
          nowMs: now,
          lastRotatedMsAgo,
        });
        const cmdSilenceMin = Math.round(
          (commandSilenceMs ?? sessionAgeMs) / 60_000,
        );
        const v2Stats = `cmdSilenceMin=${cmdSilenceMin} subscribes30m=${countRecent(subscribeTimes, now)} giveUps30m=${countRecent(giveUpTimes, now)}`;
        if (v2 && !v1) {
          this.log.info(`wedge v2 would rotate session ${s.id}: ${v2Stats}`);
        }
        if (!v1) {
          continue;
        }
        this.log.info(
          `wedge v2 session ${s.id}: v1 rotated, v2 agree=${v2} ${v2Stats}`,
        );
        const silenceMin = Math.round(
          (lastImRequestMsAgo ?? sessionAgeMs) / 60_000,
        );
        this.log.info(
          `Wedge watchdog: rotating session ${s.id}, no inbound interaction for ${silenceMin}min`,
        );
        this.wedgeLastRotatedAt.set(s, now);
        closes.push(
          s.initiateClose().catch(() => {
            return s.initiateForceClose({
              cause: new Error("wedge watchdog, forcing"),
            });
          }),
        );
      }
      if (closes.length > 0) {
        Promise.allSettled(closes).then(() => this.triggerMdnsReAnnounce());
      }
    } catch {
      // SessionManager may be disposed
    }
  }

  // Poll the interface addresses mDNS advertises and re-announce when they
  // change. matter.js caches the operational records at first announcement, so
  // a dynamic ISP IPv6 prefix change keeps advertising the dead global address
  // until a restart (#415). refreshOperationalAdvertisement re-runs the lookup.
  private startMdnsAddressWatch() {
    this.stopMdnsAddressWatch();
    const { netInterface, stripGlobalIpv6, ipv4Enabled } =
      this.readMdnsWatchSettings();
    this.advertisedAddressSnapshot = collectAdvertisedAddresses(
      os.networkInterfaces(),
      netInterface,
      stripGlobalIpv6,
      ipv4Enabled,
    );
    this.mdnsAddressTimer = setInterval(() => {
      if (this.mdnsCheckInFlight) return;
      this.mdnsCheckInFlight = true;
      this.checkAdvertisedAddresses()
        .catch((e) => {
          this.log.warn("mDNS address check failed:", e);
        })
        .finally(() => {
          this.mdnsCheckInFlight = false;
        });
    }, MDNS_ADDRESS_CHECK_INTERVAL_MS);
  }

  private stopMdnsAddressWatch() {
    if (this.mdnsAddressTimer) {
      clearInterval(this.mdnsAddressTimer);
      this.mdnsAddressTimer = null;
    }
  }

  // Read the mDNS settings the shared setup applied. MdnsService lives on the
  // root env and stripGlobalIpv6 swaps in a FilteredNetwork, so both are
  // visible from the bridge env.
  private readMdnsWatchSettings(): {
    netInterface?: string;
    stripGlobalIpv6: boolean;
    ipv4Enabled: boolean;
  } {
    try {
      const mdns = this.server.env.get(MdnsService);
      const stripGlobalIpv6 =
        this.server.env.get(Network) instanceof FilteredNetwork;
      return {
        netInterface: mdns.limitedToNetInterface,
        stripGlobalIpv6,
        ipv4Enabled: mdns.enableIpv4,
      };
    } catch {
      return { stripGlobalIpv6: false, ipv4Enabled: true };
    }
  }

  private async checkAdvertisedAddresses() {
    const { netInterface, stripGlobalIpv6, ipv4Enabled } =
      this.readMdnsWatchSettings();
    const advertiser = this.server.env.get(DeviceAdvertiser);
    const fabrics = this.server.env.get(FabricManager);
    this.advertisedAddressSnapshot = await runMdnsAddressWatchTick({
      readInterfaces: () => os.networkInterfaces(),
      netInterface,
      stripGlobalIpv6,
      ipv4Enabled,
      currentSnapshot: this.advertisedAddressSnapshot,
      fabrics: () => fabrics.fabrics,
      refresh: (fabric) =>
        advertiser.refreshOperationalAdvertisement(fabric as Fabric),
      onChange: (prev, curr) => {
        this.log.warn(
          `Advertised address set changed (${prev.length} -> ${curr.length} addresses), re-announcing operational mDNS (#415)`,
        );
      },
    });
  }

  // Resolve the rotation max age. Bridge config wins, then the env var. An
  // aggregator bridge holds many devices on one controller session, so
  // rotating it re-subscribes them all at once. Rotation is therefore opt-in
  // here: it stays disabled unless set via config or the env var.
  private readSessionMaxAgeHours(): number {
    const { min, max } = SESSION_MAX_AGE_HOURS_RANGE;
    const fromConfig = this.dataProvider.sessionMaxAgeHours;
    if (fromConfig != null && Number.isFinite(fromConfig) && fromConfig >= 0) {
      if (fromConfig === 0) return 0;
      if (fromConfig < min) return min;
      if (fromConfig > max) return max;
      return fromConfig;
    }
    const raw = process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS;
    if (raw == null || raw === "") {
      return 0;
    }
    const parsed = parseSessionMaxAgeHours(raw);
    if (parsed == null) {
      this.log.warn(
        `Invalid HAMH_MATTER_SESSION_MAX_AGE_HOURS=${raw}, disabling session rotation`,
      );
      return 0;
    }
    return parsed;
  }

  // Gracefully close sessions older than maxSessionAgeMs that still hold
  // subscriptions, so the controller re-establishes CASE and re-subscribes.
  // 0-sub sessions are handled by the dead/stale-session path.
  private rotateAgedSessions() {
    if (this.maxSessionAgeMs === 0) return;
    try {
      const sessionManager = this.server.env.get(SessionManager);
      const now = Date.now();
      const closes: Promise<void>[] = [];
      for (const s of [...sessionManager.sessions]) {
        const startedAt = this.sessionStartedAt.get(s.id);
        if (startedAt == null) continue;
        const ageMs = now - startedAt;
        if (
          ageMs < this.maxSessionAgeMs ||
          s.isClosing ||
          s.subscriptions.size === 0
        ) {
          continue;
        }
        const ageMin = Math.round(ageMs / 60_000);
        this.log.info(
          `Rotating session ${s.id} (peer ${s.peerNodeId}, age ${ageMin}min, subs ${s.subscriptions.size})`,
        );
        closes.push(
          s.initiateClose().catch(() => {
            return s.initiateForceClose({
              cause: new Error("session rotation, forcing"),
            });
          }),
        );
      }
      if (closes.length > 0) {
        Promise.allSettled(closes).then(() => this.triggerMdnsReAnnounce());
      }
    } catch {
      // SessionManager may be disposed
    }
  }

  async update(update: UpdateBridgeRequest) {
    try {
      this.dataProvider.update(update);
      await this.refreshDevices();
      // Re-evaluate auto force sync and session rotation after config update
      if (this.status.code === BridgeStatus.Running) {
        this.startAutoForceSyncIfEnabled();
        this.startSessionRotation();
        this.startWedgeWatchdog();
      }
    } catch (e) {
      const reason = "Failed to update bridge due to error:";
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  async factoryReset() {
    if (this.status.code !== BridgeStatus.Running) {
      return;
    }
    await this.server.factoryReset();
    this.setStatus({ code: BridgeStatus.Stopped });
    await this.start();
  }

  /**
   * Open a basic commissioning window so additional controllers can pair.
   * After first commissioning the bridge stops advertising; this re-enables
   * mDNS commissionable advertising with the original passcode/discriminator
   * for the standard 15-minute window.
   */
  async openCommissioningWindow(): Promise<void> {
    if (this.status.code !== BridgeStatus.Running) {
      throw new Error("Bridge is not running");
    }
    const commissioning = this.server.state.commissioning;
    if (!commissioning.commissioned) {
      throw new Error("Bridge is not yet commissioned");
    }
    await this.server.act((agent) =>
      agent.get(CommissioningServer).enterCommissionableMode(),
    );
    this.log.info("Opened basic commissioning window for multi-fabric pairing");
  }

  /**
   * Force sync all device states to connected controllers.
   * Only pushes state for endpoints whose entity state has actually changed
   * since the last sync. This avoids unnecessary MRP traffic that could
   * trigger session loss during brief network interruptions.
   */
  async forceSync(): Promise<number> {
    if (this.status.code !== BridgeStatus.Running) {
      return 0;
    }

    if (!this.dataProvider.featureFlags?.autoForceSync) {
      return 0;
    }

    if (isHeapUnderPressure()) {
      this.log.warn(
        "Force sync skipped: heap under pressure, reduce entities or raise NODE_OPTIONS=--max-old-space-size",
      );
      return 0;
    }

    // Import dynamically to avoid circular dependencies
    const { HomeAssistantEntityBehavior } = await import(
      "../../matter/behaviors/home-assistant-entity-behavior.js"
    );

    // Collect all endpoints recursively to include sub-endpoints
    // of composed devices (e.g., ComposedSensorEndpoint has T/H/P sub-endpoints)
    const allEndpoints: Endpoint[] = [];
    const collect = (ep: Endpoint) => {
      allEndpoints.push(ep);
      for (const child of ep.parts) {
        collect(child);
      }
    };
    for (const ep of this.aggregator.parts) {
      collect(ep);
    }

    let syncedCount = 0;
    let skippedCount = 0;

    for (const endpoint of allEndpoints) {
      try {
        if (!endpoint.behaviors.has(HomeAssistantEntityBehavior)) {
          continue;
        }

        const behavior = endpoint.stateOf(HomeAssistantEntityBehavior);
        const currentEntity = behavior.entity;

        if (currentEntity?.state) {
          const entityId = currentEntity.entity_id;
          // Compare only meaningful fields, ignore volatile HA metadata
          // (last_changed, last_updated, context) to avoid unnecessary MRP traffic.
          const stateJson = JSON.stringify({
            s: currentEntity.state.state,
            a: currentEntity.state.attributes,
          });
          const lastJson = this.lastSyncedStates.get(entityId);

          if (stateJson !== lastJson) {
            // State has changed since last sync, push update
            await endpoint.setStateOf(HomeAssistantEntityBehavior, {
              entity: {
                ...currentEntity,
                state: { ...currentEntity.state },
              },
            });
            this.lastSyncedStates.set(entityId, stateJson);
            syncedCount++;
          } else {
            skippedCount++;
          }
        }
      } catch (e) {
        this.log.debug(`Force sync: Skipped endpoint due to error:`, e);
      }
    }

    if (syncedCount > 0) {
      this.log.info(
        `Force sync: Pushed ${syncedCount} changed device(s), skipped ${skippedCount} unchanged`,
      );
    }

    return syncedCount;
  }

  async delete() {
    await this.server.delete();
  }
}
