import { InteractionServer } from "@matter/main/node";
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
