import { InteractionServer } from "@matter/main/node";
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
    lastImRequestAt: new WeakMap<object, number>(),
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
