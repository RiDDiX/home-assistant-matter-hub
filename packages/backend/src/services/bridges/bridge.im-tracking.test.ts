import { InteractionServer } from "@matter/main/node";
import { MessageType } from "@matter/main/protocol";
import { describe, expect, it } from "vitest";
import { Bridge } from "./bridge.js";

// The aggregator Bridge carries the same wedge instrumentation as
// ServerModeBridge: wireImRequestTracking wraps InteractionServer.onNewExchange
// so every inbound Interaction Model request stamps a per-session timestamp,
// surfaced as lastImRequestMsAgo. The wrap must be installed once (idempotent on
// re-wire) and delegate to the original handler.
//
// Unlike ServerModeBridge, the aggregator Bridge takes no injected server: its
// constructor eagerly builds a real matter.js ServerNode (BridgeServerNode
// extends ServerNode) from a live Environment plus aggregator Endpoint. That is
// exactly the machinery the server-mode harness sidesteps with a plain fake
// server, and there is no seam to hand the aggregator Bridge one. So rather than
// stand up that whole node, we build the instance off the prototype and wire
// only the fields the two methods under test read, then exercise the real
// wireImRequestTracking and getSessionInfo.

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
  const sessionManager = { sessions: [...sessions] };
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
  // Bypass the heavy constructor (see file header) and set only the fields
  // wireImRequestTracking and getSessionInfo touch.
  const bridge = Object.create(Bridge.prototype) as Bridge;
  Object.assign(bridge as unknown as Record<string, unknown>, {
    server,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    lastImRequestAt: new WeakMap<object, number>(),
    lastCommandImAt: new WeakMap<object, number>(),
    subscribeTimesMs: new WeakMap<object, number[]>(),
    giveUpTimesMs: new WeakMap<object, number[]>(),
    wedgeHookedSessions: new WeakSet<object>(),
    wedgeLastRotatedAt: new WeakMap<object, number>(),
    sessionStartedAt: new Map<number, number>(),
  });
  const wire = () =>
    (
      bridge as unknown as { wireImRequestTracking(): void }
    ).wireImRequestTracking();
  return {
    bridge,
    fakeIs,
    wire,
    getOriginalCalls: () => originalCalls,
  };
}

describe("Bridge inbound IM request tracking", () => {
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

describe("Bridge IM message type split (#365 v2)", () => {
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
// with a fresh inbound IM stamp). Only the former lands in the ring.
function makeDeletedObservable() {
  const fns: Array<(sub: unknown) => void> = [];
  return {
    on: (fn: (sub: unknown) => void) => fns.push(fn),
    emit: (sub: unknown) => {
      for (const fn of fns) fn(sub);
    },
  };
}

describe("Bridge subscription give-up tracking (#365 v2)", () => {
  function makeGiveUpSetup() {
    const deleted = makeDeletedObservable();
    const sess = makeSession({
      subscriptions: Object.assign([], { size: 1, deleted }) as never,
    });
    const { bridge } = makeBridge([sess]);
    const hook = (peerSessions?: () => Iterable<object>) =>
      (
        bridge as unknown as {
          hookSubscriptionGiveUps(
            session: object,
            peerSessions?: () => Iterable<object>,
          ): void;
        }
      ).hookSubscriptionGiveUps(sess, peerSessions);
    const stampInbound = (msAgo: number) =>
      (
        bridge as unknown as { lastImRequestAt: WeakMap<object, number> }
      ).lastImRequestAt.set(sess, Date.now() - msAgo);
    const giveUps = () => bridge.getSessionInfo().sessions[0].giveUpsLast30Min;
    return { deleted, hook, stampInbound, giveUps, bridgeRef: bridge, sess };
  }

  it("records a terminated sub with a stale inbound stamp", () => {
    const { deleted, hook, stampInbound, giveUps } = makeGiveUpSetup();
    hook();
    stampInbound(10_000);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(1);
  });

  it("records a terminated sub when no inbound was ever stamped", () => {
    const { deleted, hook, giveUps } = makeGiveUpSetup();
    hook();
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(1);
  });

  it("skips a terminated sub coinciding with fresh inbound (peer cancel)", () => {
    const { deleted, hook, stampInbound, giveUps } = makeGiveUpSetup();
    hook();
    stampInbound(0);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(0);
  });

  it("skips a termination when a sibling session of the peer took the inbound", () => {
    // keepSubscriptions=false on session B cancels A's subs too; the stamp
    // sits on B, so a per-session check would count a phantom give-up on A.
    const { deleted, hook, giveUps, bridgeRef, sess } = makeGiveUpSetup();
    const sibling = { fresh: true };
    (
      bridgeRef as unknown as { lastImRequestAt: WeakMap<object, number> }
    ).lastImRequestAt.set(sibling, Date.now());
    hook(() => [sess, sibling]);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(0);
  });

  it("still counts a give-up when every peer session is quiet", () => {
    const { deleted, hook, giveUps, sess } = makeGiveUpSetup();
    const sibling = { quiet: true };
    hook(() => [sess, sibling]);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(1);
  });

  it("skips a sub removed by session teardown (isTerminated false)", () => {
    const { deleted, hook, stampInbound, giveUps } = makeGiveUpSetup();
    hook();
    stampInbound(10_000);
    deleted.emit({ subscriptionId: 5, isTerminated: false });
    expect(giveUps()).toBe(0);
  });

  it("hooks a session only once", () => {
    const { deleted, hook, stampInbound, giveUps } = makeGiveUpSetup();
    hook();
    hook();
    stampInbound(10_000);
    deleted.emit({ subscriptionId: 5, isTerminated: true });
    expect(giveUps()).toBe(1);
  });
});
