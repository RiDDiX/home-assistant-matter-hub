import * as os from "node:os";
import { alexaPairingPortProblem } from "@home-assistant-matter-hub/common";
import type { Environment, Logger } from "@matter/general";
import { Network } from "@matter/main";
import { InteractionServer } from "@matter/main/node";
import {
  DeviceAdvertiser,
  type Fabric,
  FabricManager,
  MdnsService,
  MessageType,
  SessionManager,
} from "@matter/main/protocol";
import { FilteredNetwork } from "../../core/app/filtered-network.js";
import {
  collectAdvertisedAddresses,
  runMdnsAddressWatchTick,
} from "../../matter/mdns-address-watch.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
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

// On shutdown, wait at most this long for active sessions to close cleanly.
// A clean close tells the controller to drop its CASE session right away
// instead of holding a stale one until its own timeout, which is what leaves
// a controller showing the bridge as unresponsive after a restart.
const SHUTDOWN_SESSION_CLOSE_TIMEOUT_MS = 2_500;

// How often to re-check the interface addresses mDNS advertises. A dynamic ISP
// IPv6 prefix change swaps the global address behind the cached operational
// records, so poll and re-announce when the set moves (#415).
const MDNS_ADDRESS_CHECK_INTERVAL_MS = 60_000;

// Everything a bridge does to its controller sessions once the node runs:
// diagnostics, stale and dead session cleanup, rotation, the wedge watchdog
// and the mDNS address watch. Bridge and ServerModeBridge carried this twice,
// 97% identical, and every fix landed in one copy first.
export class SessionSupervisor {
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

  constructor(
    private readonly log: Logger,
    // only ever server.env.get(...), so both node types fit
    private readonly server: { env: Environment },
    private readonly dataProvider: BridgeDataProvider,
    // the diagnostic events need the real bridge data getter, its device
    // count comes from the aggregator on one side and the node on the other
    private readonly bridgeInfo: () => { id: string; name: string },
    private readonly defaultMaxAgeHours: number,
  ) {}

  // after server.start(); wireSessionDiagnostics self-unwires first because
  // factoryReset restarts without going through stop()
  start(): void {
    this.wireSessionDiagnostics();
    this.wireFabricWarnings();
    this.startSessionRotation();
    this.startWedgeWatchdog();
    this.startMdnsAddressWatch();
  }

  // before server.cancel(); unwireSessionDiagnostics also stops the timers
  stop(): void {
    this.unwireSessionDiagnostics();
    this.unwireFabricWarnings();
  }

  // bridge config changed while running
  reconfigure(): void {
    this.startSessionRotation();
    this.startWedgeWatchdog();
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
            bridgeId: this.bridgeInfo().id,
            bridgeName: this.bridgeInfo().name,
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
            bridgeId: this.bridgeInfo().id,
            bridgeName: this.bridgeInfo().name,
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
            bridgeId: this.bridgeInfo().id,
            bridgeName: this.bridgeInfo().name,
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
  async closeActiveSessions() {
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

  // Env var unset or garbage falls back to defaultMaxAgeHours: 0 on the
  // aggregator bridge (rotation opt-in, one controller session holds many
  // devices), DEFAULT_SESSION_MAX_AGE_HOURS in server mode.
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
      return this.defaultMaxAgeHours;
    }
    const parsed = parseSessionMaxAgeHours(raw);
    if (parsed == null) {
      this.log.warn(
        `Invalid HAMH_MATTER_SESSION_MAX_AGE_HOURS=${raw}, ${
          this.defaultMaxAgeHours === 0
            ? "disabling session rotation"
            : `falling back to ${this.defaultMaxAgeHours}h`
        }`,
      );
      return this.defaultMaxAgeHours;
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
}
