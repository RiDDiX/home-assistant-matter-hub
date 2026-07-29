import * as os from "node:os";
import {
  alexaPairingPortProblem,
  BridgeStatus,
  type ExposedDeviceType,
  type UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import { Network } from "@matter/main";
import { CommissioningServer, InteractionServer } from "@matter/main/node";
import {
  DeviceAdvertiser,
  type Fabric,
  FabricManager,
  MdnsService,
  SessionManager,
} from "@matter/main/protocol";
import { FilteredNetwork } from "../../core/app/filtered-network.js";
import type { LoggerService } from "../../core/app/logger.js";
import type { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import {
  collectAdvertisedAddresses,
  runMdnsAddressWatchTick,
} from "../../matter/mdns-address-watch.js";
import { ensureCommissioningConfig } from "../../utils/ensure-commissioning-config.js";
import { logMemoryUsage } from "../../utils/log-memory.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import type {
  BridgeDataProvider,
  BridgeServerStatus,
} from "./bridge-data-provider.js";
import type { ServerModeEndpointManager } from "./server-mode-endpoint-manager.js";
import {
  DEFAULT_SESSION_MAX_AGE_HOURS,
  deadSessionTimeoutMs,
  parseSessionMaxAgeHours,
  ROTATION_CHECK_INTERVAL_MS,
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
import { decideWedgeRotation } from "./wedge-watchdog.js";

// Marks an InteractionServer whose onNewExchange we already wrapped so re-wiring
// never stacks wrappers. A restart mints a fresh InteractionServer without the
// marker, so it gets wrapped again.
const imWrapMarker = Symbol("hamh.wedgeImWrap");

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

export function makeWarmStartState<T extends { last_updated?: string }>(
  state: T,
  now = new Date().toISOString(),
): T {
  return { ...state, last_updated: now };
}

/**
 * ServerModeBridge exposes a single device as a standalone Matter device.
 * This is required for Apple Home to properly support Siri voice commands
 * for Robot Vacuums (RVC) and similar device types.
 */
export class ServerModeBridge {
  private readonly log: Logger;

  private status: BridgeServerStatus = {
    code: BridgeStatus.Stopped,
    reason: undefined,
  };

  // Called whenever the bridge status changes. Set by BridgeService to
  // broadcast updates via WebSocket so the frontend sees every transition.
  public onStatusChange?: () => void;

  private autoForceSyncTimer: ReturnType<typeof setInterval> | null = null;
  private deadSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private staleSessionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private warmStartTimer: ReturnType<typeof setTimeout> | null = null;

  // Tracks when each session opened, used for age-based rotation (#287).
  private sessionStartedAt = new Map<number, number>();
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private maxSessionAgeMs = 0;

  // Wedge watchdog: last inbound Interaction Model request time per session and
  // last time the watchdog rotated it, both keyed by the long-lived session
  // object so they clear when the session goes away.
  private lastImRequestAt = new WeakMap<object, number>();
  private wedgeLastRotatedAt = new WeakMap<object, number>();
  private wedgeWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // Watches the advertised interface addresses so a dynamic ISP IPv6 prefix
  // change forces a fresh operational announcement (#415).
  private mdnsAddressTimer: ReturnType<typeof setInterval> | null = null;
  private advertisedAddressSnapshot: string[] = [];
  // Skip a tick while the previous one is still awaiting refresh, so a slow
  // refreshOperationalAdvertisement can't overlap and re-announce off a stale
  // snapshot.
  private mdnsCheckInFlight = false;

  // Tracks the last synced state JSON per entity to avoid pushing unchanged states.
  private readonly lastSyncedStates = new Map<string, string>();

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

  get id(): string {
    return this.dataProvider.id;
  }

  get data() {
    return this.dataProvider.withMetadata(
      this.status,
      this.server,
      this.endpointManager.devices.length,
      this.endpointManager.failedEntities,
      this.getExposedDeviceTypes(),
    );
  }

  /**
   * The entity id and numeric Matter device type of every exposed device, so a
   * controller-support warning can be raised per bridge (#365 class). Server
   * mode is flat, but walk parts anyway to stay correct.
   */
  getExposedDeviceTypes(): ExposedDeviceType[] {
    const out: ExposedDeviceType[] = [];
    const collect = (
      ep: {
        type?: { deviceType?: number };
        entityId?: string;
        parts: Iterable<unknown>;
      },
      inheritedEntityId?: string,
    ) => {
      const entityId = ep.entityId ?? inheritedEntityId;
      const deviceTypeId = ep.type?.deviceType;
      if (typeof deviceTypeId === "number" && entityId) {
        out.push({ entityId, deviceTypeId });
      }
      for (const child of ep.parts) {
        collect(child as typeof ep, entityId);
      }
    };
    for (const device of this.endpointManager.devices) {
      collect(device as unknown as Parameters<typeof collect>[0]);
    }
    return out;
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
        // #365: per-session liveness and per-fabric roll-up, mirrors
        // Bridge.getSessionInfo so the health view matches in server mode.
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
        return {
          id: s.id,
          peerNodeId: String(s.peerNodeId),
          fabricIndex: fi,
          subscriptionCount: subCount,
          subscriptions,
          lastActiveMsAgo,
          lastAnyActivityMsAgo,
          lastImRequestMsAgo,
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

  constructor(
    logger: LoggerService,
    private readonly dataProvider: BridgeDataProvider,
    private readonly endpointManager: ServerModeEndpointManager,
    readonly server: ServerModeServerNode,
  ) {
    this.log = logger.get(`ServerModeBridge / ${dataProvider.id}`);
  }

  async initialize(): Promise<void> {
    await this.server.construction.ready.then();
    await this.refreshDevices();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  async refreshDevices(): Promise<void> {
    await this.endpointManager.refreshDevices();
  }

  private setStatus(status: BridgeServerStatus) {
    this.status = status;
    this.onStatusChange?.();
  }

  async start(): Promise<void> {
    if (this.status.code === BridgeStatus.Running) {
      return;
    }
    this.lastSyncedStates.clear();
    try {
      this.setStatus({
        code: BridgeStatus.Starting,
        reason: "The server mode bridge is starting... Please wait.",
      });
      await this.refreshDevices();
      logMemoryUsage(this.log, "after refreshDevices (server mode)");
      this.endpointManager.startObserving();
      ensureCommissioningConfig(this.server);
      await this.server.start();
      this.setStatus({ code: BridgeStatus.Running });
      this.startAutoForceSyncIfEnabled();
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
      this.scheduleWarmStart();
      logMemoryUsage(this.log, "server mode bridge running");
      this.log.info("Server mode bridge started");
      diagnosticEventBus.emit("bridge_started", "Server mode bridge started", {
        bridgeId: this.id,
        bridgeName: this.dataProvider.name,
      });
    } catch (e) {
      const reason = "Failed to start server mode bridge due to error:";
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  async stop(
    code: BridgeStatus = BridgeStatus.Stopped,
    reason = "Manually stopped",
  ): Promise<void> {
    this.stopSessionRotation();
    this.stopWedgeWatchdog();
    this.stopMdnsAddressWatch();
    this.unwireSessionDiagnostics();
    this.unwireFabricWarnings();
    this.cancelWarmStart();
    this.stopAutoForceSync();
    await this.closeActiveSessions();
    this.endpointManager.stopObserving();
    try {
      await this.server.cancel();
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (!errorMessage.includes("mutex-closed")) {
        this.log.warn("Error stopping server mode bridge:", e);
      }
    }
    this.setStatus({ code, reason });
    diagnosticEventBus.emit(
      "bridge_stopped",
      `Server mode bridge stopped: ${reason}`,
      {
        bridgeId: this.id,
        bridgeName: this.dataProvider.name,
      },
    );
  }

  async update(update: UpdateBridgeRequest): Promise<void> {
    try {
      this.dataProvider.update(update);
      await this.refreshDevices();
      // Re-evaluate auto force sync setting after config update
      if (this.status.code === BridgeStatus.Running) {
        this.startAutoForceSyncIfEnabled();
        // Re-read sessionMaxAgeHours so UI changes apply without restart (#287)
        this.startSessionRotation();
        this.startWedgeWatchdog();
      }
    } catch (e) {
      const reason = "Failed to update server mode bridge due to error:";
      this.log.error(reason, e);
      await this.stop(BridgeStatus.Failed, `${reason}\n${e?.toString()}`);
    }
  }

  async factoryReset(): Promise<void> {
    if (this.status.code !== BridgeStatus.Running) {
      return;
    }
    await this.server.factoryReset();
    this.setStatus({ code: BridgeStatus.Stopped });
    await this.start();
  }

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
      seedExistingSessionStarts(this.sessionStartedAt, sessionManager.sessions);
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
          this.lastImRequestAt.set(session, Date.now());
        }
        return original(exchange, message);
      };
      marked[imWrapMarker] = true;
    } catch {
      // InteractionServer not yet available
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
      if (kept > 0 && !this.deadSessionTimer) {
        // Some peers are still active; re-check after another interval.
        this.deadSessionTimer = setTimeout(() => {
          this.deadSessionTimer = null;
          this.closeDeadSessions();
        }, deadSessionTimeoutMs(this.dataProvider.featureFlags));
      }
      if (closes.length > 0) {
        Promise.allSettled(closes).then(() => this.triggerMdnsReAnnounce());
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

  // Start the periodic age-based session rotation (#287).
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
        if (
          !decideWedgeRotation({
            subscriptionCount: s.subscriptions.size,
            sessionAgeMs,
            lastImRequestMsAgo,
            lastRotatedMsAgo,
          })
        ) {
          continue;
        }
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

  // Resolve session rotation max age. Bridge config wins, then env var,
  // then built-in default. 0 disables, otherwise clamped to range.
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
    const parsed = parseSessionMaxAgeHours(raw);
    if (parsed == null) {
      this.log.warn(
        `Invalid HAMH_MATTER_SESSION_MAX_AGE_HOURS=${raw}, falling back to ${DEFAULT_SESSION_MAX_AGE_HOURS}h`,
      );
      return DEFAULT_SESSION_MAX_AGE_HOURS;
    }
    return parsed;
  }

  // Gracefully close sessions older than maxSessionAgeMs so controllers
  // re-establish CASE and re-subscribe. Stale (0-sub) sessions are handled
  // by the existing dead-session path, so only rotate ones with subscriptions.
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

  private stopAutoForceSync() {
    if (this.autoForceSyncTimer) {
      clearInterval(this.autoForceSyncTimer);
      this.autoForceSyncTimer = null;
    }
  }

  /**
   * Schedule a one-time state push shortly after bridge start.
   * This refreshes internal attribute versions so that controllers
   * reading attributes after session establishment get current data.
   */
  private scheduleWarmStart() {
    this.cancelWarmStart();
    this.warmStartTimer = setTimeout(() => {
      this.warmStartTimer = null;
      this.pushCurrentState().catch((e) => {
        this.log.debug("Warm-start state push failed:", e);
      });
    }, 15_000);
  }

  private cancelWarmStart() {
    if (this.warmStartTimer) {
      clearTimeout(this.warmStartTimer);
      this.warmStartTimer = null;
    }
  }

  /**
   * Push the current device state unconditionally.
   * Unlike forceSync, this ignores the autoForceSync flag and always pushes.
   */
  private async pushCurrentState(): Promise<void> {
    if (this.status.code !== BridgeStatus.Running) {
      return;
    }
    const devices = this.endpointManager.devices;
    if (devices.length === 0) {
      return;
    }
    const { HomeAssistantEntityBehavior } = await import(
      "../../matter/behaviors/home-assistant-entity-behavior.js"
    );
    let pushed = 0;
    for (const device of devices) {
      try {
        if (!device.behaviors.has(HomeAssistantEntityBehavior)) {
          continue;
        }
        const behavior = device.stateOf(HomeAssistantEntityBehavior);
        const currentEntity = behavior.entity;
        if (currentEntity?.state) {
          await device.setStateOf(HomeAssistantEntityBehavior, {
            entity: {
              ...currentEntity,
              state: makeWarmStartState(currentEntity.state),
            },
          });
          pushed++;
        }
      } catch (e) {
        this.log.debug("Warm-start: Failed to push state:", e);
      }
    }
    if (pushed > 0) {
      this.log.info(`Warm-start: Pushed initial state for ${pushed} devices`);
    }
  }

  async delete(): Promise<void> {
    await this.server.delete();
  }

  /**
   * Force sync the device state to all connected Matter controllers.
   * Only pushes state when the entity state has actually changed since
   * the last sync to avoid unnecessary MRP traffic.
   */
  async forceSync(): Promise<number> {
    if (this.status.code !== BridgeStatus.Running) {
      return 0;
    }

    if (!this.dataProvider.featureFlags?.autoForceSync) {
      return 0;
    }

    const devices = this.endpointManager.devices;
    if (devices.length === 0) {
      return 0;
    }

    // Import dynamically to avoid circular dependencies
    const { HomeAssistantEntityBehavior } = await import(
      "../../matter/behaviors/home-assistant-entity-behavior.js"
    );

    let synced = 0;
    for (const device of devices) {
      try {
        if (!device.behaviors.has(HomeAssistantEntityBehavior)) {
          continue;
        }

        const behavior = device.stateOf(HomeAssistantEntityBehavior);
        const currentEntity = behavior.entity;

        if (currentEntity?.state) {
          // Compare only meaningful fields, ignore volatile HA metadata
          // (last_changed, last_updated, context) to avoid unnecessary MRP traffic.
          const stateJson = JSON.stringify({
            s: currentEntity.state.state,
            a: currentEntity.state.attributes,
          });

          if (stateJson !== this.lastSyncedStates.get(device.entityId)) {
            // State has changed since last sync, push update
            await device.setStateOf(HomeAssistantEntityBehavior, {
              entity: {
                ...currentEntity,
                state: { ...currentEntity.state },
              },
            });
            this.lastSyncedStates.set(device.entityId, stateJson);
            synced++;
          }
        }
      } catch (e) {
        this.log.debug("Force sync: Failed due to error:", e);
      }
    }

    if (synced > 0) {
      this.log.info(`Force sync: Pushed ${synced} changed devices`);
    }
    return synced;
  }
}
