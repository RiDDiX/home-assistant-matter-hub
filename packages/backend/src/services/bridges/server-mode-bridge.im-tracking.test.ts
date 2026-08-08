import { InteractionServer } from "@matter/main/node";
import { MessageType } from "@matter/main/protocol";
import { describe, expect, it } from "vitest";
import { ServerModeBridge } from "./server-mode-bridge.js";

// Instrumentation: wireSessionDiagnostics wraps InteractionServer.onNewExchange
// so every inbound Interaction Model request stamps a per-session timestamp,
// surfaced as lastImRequestMsAgo. The wrap must be installed once (idempotent
// on re-wire) and delegate to the original handler.

type SessionHandler = (session: never) => void;

interface FakeSession {
  id: number;
  peerNodeId: unknown;
  fabric?: { fabricIndex: number };
  subscriptions: { size: number };
  activeTimestamp: number;
  timestamp: number;
  isPeerActive: boolean;
}

function makeBridge(sessions: FakeSession[] = []) {
  const logger = {
    get: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  };
  const handlers: {
    subscriptionsChanged?: SessionHandler;
    added?: SessionHandler;
    deleted?: SessionHandler;
  } = {};
  const sessionList = Object.assign([...sessions], {
    added: { on: (fn: SessionHandler) => (handlers.added = fn) },
    deleted: { on: (fn: SessionHandler) => (handlers.deleted = fn) },
  });
  const sessionManager = {
    sessions: sessionList,
    subscriptionsChanged: {
      on: (fn: SessionHandler) => (handlers.subscriptionsChanged = fn),
    },
  };
  let originalCalls = 0;
  const fakeIs = {
    onNewExchange: (_exchange: unknown, _message: unknown) => {
      originalCalls++;
      return Promise.resolve();
    },
  };
  const env = {
    get: (key: unknown) =>
      key === InteractionServer ? fakeIs : sessionManager,
  };
  const server = { env };
  const dataProvider = {
    id: "bridge-1",
    name: "Test Bridge",
    featureFlags: {},
    withMetadata: () => ({ id: "bridge-1", name: "Test Bridge" }),
  };
  const endpointManager = { devices: [], failedEntities: [] };
  const bridge = new ServerModeBridge(
    logger as never,
    dataProvider as never,
    endpointManager as never,
    server as never,
  );
  const wire = () =>
    (
      bridge as unknown as { wireSessionDiagnostics(): void }
    ).wireSessionDiagnostics();
  return {
    bridge,
    handlers,
    fakeIs,
    wire,
    getOriginalCalls: () => originalCalls,
  };
}

describe("ServerModeBridge inbound IM request tracking", () => {
  it("wraps onNewExchange exactly once across re-wiring", () => {
    const { fakeIs, wire } = makeBridge();
    const before = fakeIs.onNewExchange;
    wire();
    const afterFirst = fakeIs.onNewExchange;
    expect(afterFirst).not.toBe(before);
    wire();
    expect(fakeIs.onNewExchange).toBe(afterFirst);
  });

  it("delegates to the original handler and stamps the session", async () => {
    const sess: FakeSession = {
      id: 1,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 1 },
      activeTimestamp: Date.now(),
      timestamp: Date.now(),
      isPeerActive: true,
    };
    const { bridge, fakeIs, wire, getOriginalCalls } = makeBridge([sess]);
    const original = fakeIs.onNewExchange;
    wire();
    // The wrapper must actually be installed, otherwise the delegate counter
    // still climbs and the stamp never lands, so both checks below are moot.
    expect(fakeIs.onNewExchange).not.toBe(original);
    expect(bridge.getSessionInfo().sessions[0].lastImRequestMsAgo).toBeNull();

    await fakeIs.onNewExchange({ session: sess }, {});

    expect(getOriginalCalls()).toBe(1);
    expect(
      bridge.getSessionInfo().sessions[0].lastImRequestMsAgo,
    ).not.toBeNull();
  });

  it("reports lastImRequestMsAgo null until an inbound request arrives", () => {
    const sess: FakeSession = {
      id: 1,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 1 },
      activeTimestamp: Date.now(),
      timestamp: Date.now(),
      isPeerActive: true,
    };
    const { bridge, fakeIs, wire } = makeBridge([sess]);
    wire();

    const before = bridge.getSessionInfo().sessions[0];
    expect(before.lastImRequestMsAgo).toBeNull();

    fakeIs.onNewExchange({ session: sess }, {});

    const after = bridge.getSessionInfo().sessions[0];
    expect(after.lastImRequestMsAgo).not.toBeNull();
    expect(after.lastImRequestMsAgo).toBeGreaterThanOrEqual(0);
  });
});

function makeSession(over: Partial<FakeSession> = {}): FakeSession {
  return {
    id: 1,
    peerNodeId: 10n,
    fabric: { fabricIndex: 1 },
    subscriptions: { size: 1 },
    activeTimestamp: Date.now(),
    timestamp: Date.now(),
    isPeerActive: true,
    ...over,
  };
}

describe("ServerModeBridge IM message type split (#365 v2)", () => {
  it("stamps command and any-request time for an InvokeRequest", async () => {
    const sess = makeSession();
    const { bridge, fakeIs, wire } = makeBridge([sess]);
    wire();

    await fakeIs.onNewExchange(
      { session: sess },
      { payloadHeader: { messageType: MessageType.InvokeRequest } },
    );

    const info = bridge.getSessionInfo().sessions[0];
    expect(info.lastImRequestMsAgo).not.toBeNull();
    expect(info.lastCommandImRequestMsAgo).not.toBeNull();
    expect(info.subscribesLast30Min).toBe(0);
  });

  it("stamps the subscribe ring, not the command stamp, for a SubscribeRequest", async () => {
    const sess = makeSession();
    const { bridge, fakeIs, wire } = makeBridge([sess]);
    wire();

    await fakeIs.onNewExchange(
      { session: sess },
      { payloadHeader: { messageType: MessageType.SubscribeRequest } },
    );

    const info = bridge.getSessionInfo().sessions[0];
    expect(info.lastImRequestMsAgo).not.toBeNull();
    expect(info.lastCommandImRequestMsAgo).toBeNull();
    expect(info.subscribesLast30Min).toBe(1);
  });

  it("stamps only the any-request time when the payload header is missing", async () => {
    const sess = makeSession();
    const { bridge, fakeIs, wire } = makeBridge([sess]);
    wire();

    await fakeIs.onNewExchange({ session: sess }, {});

    const info = bridge.getSessionInfo().sessions[0];
    expect(info.lastImRequestMsAgo).not.toBeNull();
    expect(info.lastCommandImRequestMsAgo).toBeNull();
    expect(info.subscribesLast30Min).toBe(0);
  });
});

// Give-up hook: subscriptions.deleted with isTerminated true means either a
// server delivery give-up (no coincident inbound) or a peer cancel (arrives
// with a fresh inbound IM stamp). Only the former lands in the ring. Wired
// through the real sessions.added handler.
function makeDeletedObservable() {
  const fns: Array<(sub: unknown) => void> = [];
  return {
    on: (fn: (sub: unknown) => void) => fns.push(fn),
    emit: (sub: unknown) => {
      for (const fn of fns) fn(sub);
    },
  };
}

describe("ServerModeBridge subscription give-up tracking (#365 v2)", () => {
  function makeGiveUpSetup() {
    const deleted = makeDeletedObservable();
    const sess = makeSession({
      subscriptions: Object.assign([], { size: 1, deleted }) as never,
    });
    const { bridge, handlers, wire } = makeBridge([sess]);
    wire();
    const added = () => handlers.added?.(sess as never);
    const stampInbound = (msAgo: number) =>
      (
        bridge as unknown as { lastImRequestAt: WeakMap<object, number> }
      ).lastImRequestAt.set(sess, Date.now() - msAgo);
    const giveUps = () => bridge.getSessionInfo().sessions[0].giveUpsLast30Min;
    return { deleted, added, stampInbound, giveUps };
  }

  it("records a terminated sub with a stale inbound stamp", () => {
    const { deleted, added, stampInbound, giveUps } = makeGiveUpSetup();
    added();
    stampInbound(10_000);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(1);
  });

  it("records a terminated sub when no inbound was ever stamped", () => {
    const { deleted, added, giveUps } = makeGiveUpSetup();
    added();
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(1);
  });

  it("skips a terminated sub coinciding with fresh inbound (peer cancel)", () => {
    const { deleted, added, stampInbound, giveUps } = makeGiveUpSetup();
    added();
    stampInbound(0);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(0);
  });

  it("skips a sub removed by session teardown (isTerminated false)", () => {
    const { deleted, added, stampInbound, giveUps } = makeGiveUpSetup();
    added();
    stampInbound(10_000);
    deleted.emit({ subscriptionId: 5, isTerminated: false });
    expect(giveUps()).toBe(0);
  });

  it("skips a termination when a sibling session of the peer took the inbound", () => {
    // keepSubscriptions=false on a sibling session cancels this session's
    // subs too; the inbound stamp sits on the sibling.
    const deleted = makeDeletedObservable();
    const sess = makeSession({
      subscriptions: Object.assign([], { size: 1, deleted }) as never,
    });
    const sibling = makeSession({ id: 2 });
    const { bridge, handlers, wire } = makeBridge([sess, sibling]);
    wire();
    handlers.added?.(sess as never);
    (
      bridge as unknown as { lastImRequestAt: WeakMap<object, number> }
    ).lastImRequestAt.set(sibling, Date.now());
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(bridge.getSessionInfo().sessions[0].giveUpsLast30Min).toBe(0);
  });

  it("counts the give-up when the fresh stamp belongs to another peer", () => {
    const deleted = makeDeletedObservable();
    const sess = makeSession({
      subscriptions: Object.assign([], { size: 1, deleted }) as never,
    });
    const stranger = makeSession({ id: 3, peerNodeId: 99n });
    const { bridge, handlers, wire } = makeBridge([sess, stranger]);
    wire();
    handlers.added?.(sess as never);
    (
      bridge as unknown as { lastImRequestAt: WeakMap<object, number> }
    ).lastImRequestAt.set(stranger, Date.now());
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(bridge.getSessionInfo().sessions[0].giveUpsLast30Min).toBe(1);
  });

  it("hooks sessions that existed before the wire", () => {
    // A controller connected during startup fired its added event before the
    // diagnostics were wired; the wire itself must pick the session up.
    const deleted = makeDeletedObservable();
    const sess = makeSession({
      subscriptions: Object.assign([], { size: 1, deleted }) as never,
    });
    const { bridge, wire } = makeBridge([sess]);
    wire();
    (
      bridge as unknown as { lastImRequestAt: WeakMap<object, number> }
    ).lastImRequestAt.set(sess, Date.now() - 10_000);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(bridge.getSessionInfo().sessions[0].giveUpsLast30Min).toBe(1);
  });

  it("v2 shadow never closes a session v1 keeps", () => {
    // The #423 evasion shape: subscribes keep v1's stamp fresh while commands
    // are silent and give-ups pile up. v2 fires, v1 does not, nothing closes.
    const now = Date.now();
    let closes = 0;
    const sess = makeSession({
      subscriptions: Object.assign([], { size: 1 }) as never,
    }) as FakeSession & {
      isClosing: boolean;
      initiateClose: () => Promise<void>;
      initiateForceClose: () => Promise<void>;
    };
    sess.isClosing = false;
    sess.initiateClose = () => {
      closes++;
      return Promise.resolve();
    };
    sess.initiateForceClose = () => {
      closes++;
      return Promise.resolve();
    };
    const { bridge, wire } = makeBridge([sess]);
    wire();
    const b = bridge as unknown as {
      sessionStartedAt: Map<number, number>;
      lastImRequestAt: WeakMap<object, number>;
      lastCommandImAt: WeakMap<object, number>;
      subscribeTimesMs: WeakMap<object, number[]>;
      giveUpTimesMs: WeakMap<object, number[]>;
      runWedgeWatchdogCheck(): void;
    };
    b.sessionStartedAt.set(sess.id, now - 60 * 60_000);
    b.lastImRequestAt.set(sess, now - 60_000);
    b.lastCommandImAt.set(sess, now - 50 * 60_000);
    b.subscribeTimesMs.set(sess, [
      now - 20 * 60_000,
      now - 12 * 60_000,
      now - 6 * 60_000,
    ]);
    b.giveUpTimesMs.set(sess, [now - 10 * 60_000, now - 4 * 60_000]);
    b.runWedgeWatchdogCheck();
    expect(closes).toBe(0);
  });

  it("hooks a session only once across repeated added events", () => {
    const { deleted, added, stampInbound, giveUps } = makeGiveUpSetup();
    added();
    added();
    stampInbound(10_000);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(1);
  });
});
