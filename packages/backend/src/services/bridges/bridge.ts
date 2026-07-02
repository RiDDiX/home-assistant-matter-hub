import {
  type BridgeFeatureFlags,
  BridgeStatus,
  type ExposedDeviceType,
  type UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import type { Environment } from "@matter/general";
import type { Endpoint } from "@matter/main";
import { CommissioningServer } from "@matter/main/node";
import { DeviceAdvertiser, SessionManager } from "@matter/main/protocol";
import type { BetterLogger, LoggerService } from "../../core/app/logger.js";
import { BridgeServerNode } from "../../matter/endpoints/bridge-server-node.js";
import { ensureCommissioningConfig } from "../../utils/ensure-commissioning-config.js";
import { isHeapUnderPressure, logMemoryUsage } from "../../utils/log-memory.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import type {
  BridgeDataProvider,
  BridgeServerStatus,
} from "./bridge-data-provider.js";
import type { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import {
  parseSessionMaxAgeHours,
  ROTATION_CHECK_INTERVAL_MS,
  SESSION_MAX_AGE_HOURS_RANGE,
  seedExistingSessionStarts,
  staleSessionQuietWindowMs,
  staleSessionShouldClose,
} from "./session-rotation.js";

// Auto Force Sync interval in milliseconds (90 seconds).
// When autoForceSync is enabled, this pushes changed entity states to
// Matter controllers. matter.js handles subscription keepalive internally
// via empty DataReports every ~sendInterval.
const AUTO_FORCE_SYNC_INTERVAL_MS = 90_000;

// When all subscriptions are lost but sessions remain active, wait this
// long before force-closing the dead sessions. This breaks the deadlock
// where the controller holds a stale CASE session and never re-subscribes
// because it doesn't know the server canceled its subscriptions (#266).
const DEAD_SESSION_TIMEOUT_MS = 60_000;

// fastSessionRecovery: drop the dead session after 5s, not 60s (#386).
// Keep a few seconds so a normal re-subscribe isn't cut off.
const FAST_DEAD_SESSION_TIMEOUT_MS = 5_000;

export function deadSessionTimeoutMs(flags?: BridgeFeatureFlags): number {
  return flags?.fastSessionRecovery
    ? FAST_DEAD_SESSION_TIMEOUT_MS
    : DEAD_SESSION_TIMEOUT_MS;
}

// On shutdown, wait at most this long for active sessions to close cleanly.
// A clean close tells the controller to drop its CASE session right away
// instead of holding a stale one until its own timeout, which is what leaves
// a controller showing the bridge as unresponsive after a restart.
const SHUTDOWN_SESSION_CLOSE_TIMEOUT_MS = 2_500;

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
      lastActiveMsAgo: number | null;
      lastAnyActivityMsAgo: number | null;
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
        const startedAt = this.sessionStartedAt.get(s.id);
        return {
          id: s.id,
          peerNodeId: String(s.peerNodeId),
          fabricIndex: fi,
          subscriptionCount: subCount,
          lastActiveMsAgo,
          lastAnyActivityMsAgo,
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

  enablePlugin(pluginName: string): void {
    this.endpointManager.enablePlugin(pluginName);
  }

  disablePlugin(pluginName: string): void {
    this.endpointManager.disablePlugin(pluginName);
  }

  resetPlugin(pluginName: string): void {
    this.endpointManager.resetPlugin(pluginName);
  }

  getPluginConfigSchema(
    pluginName: string,
  ): Record<string, unknown> | undefined {
    return this.endpointManager.getPluginConfigSchema(pluginName);
  }

  async updatePluginConfig(
    pluginName: string,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    return this.endpointManager.updatePluginConfig(pluginName, config);
  }

  constructor(
    env: Environment,
    logger: LoggerService,
    private readonly dataProvider: BridgeDataProvider,
    private readonly endpointManager: BridgeEndpointManager,
  ) {
    this.log = logger.get(`Bridge / ${dataProvider.id}`);
    this.server = new BridgeServerNode(
      env,
      this.dataProvider,
      this.endpointManager.root,
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
      this.startSessionRotation();
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
      }) => {
        this.sessionStartedAt.set(newSession.id, Date.now());
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
            this.log.info(
              `Closing stale session ${s.id} (peer ${s.peerNodeId}, 0 subs), replaced by session ${newSession.id}`,
            );
            s.initiateForceClose({
              cause: new Error("stale session replaced by new session"),
            }).catch(() => {});
          }
        }
      };
      this.sessionDeletedHandler = (session: {
        id: number;
        peerNodeId: unknown;
      }) => {
        this.sessionStartedAt.delete(session.id);
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
    } catch {
      // SessionManager not yet available
    }
  }

  private closeStaleSession(sessionId: number) {
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
            staleSessionQuietWindowMs(this.dataProvider.featureFlags),
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
              this.closeStaleSession(sessionId);
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
    this.sessionStartedAt.clear();
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
