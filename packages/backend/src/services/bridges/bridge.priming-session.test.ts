import { SessionManager } from "@matter/main/protocol";
import { describe, expect, it, vi } from "vitest";
import { Bridge } from "./bridge.js";

// A subscription only joins session.subscriptions once its priming report
// finished, so a controller still being interviewed looks exactly like a dead
// session. Closing it there aborted the commissioning (#424 class). The
// aggregator Bridge carries the same logic as ServerModeBridge.
//
// Same prototype trick as bridge.im-tracking.test.ts: the real constructor
// builds a live ServerNode, so only the fields the handler reads are wired.

interface FakeSession {
  id: number;
  peerNodeId: bigint;
  fabric: { fabricIndex: number };
  isClosing: boolean;
  isPeerActive: boolean;
  timestamp: number;
  subscriptions: { size: number };
  initiateClose: ReturnType<typeof vi.fn>;
  initiateForceClose: ReturnType<typeof vi.fn>;
}

function fakeSession(id: number): FakeSession {
  return {
    id,
    peerNodeId: 10n,
    fabric: { fabricIndex: 1 },
    isClosing: false,
    isPeerActive: false,
    timestamp: Date.now(),
    subscriptions: { size: 0 },
    initiateClose: vi.fn().mockResolvedValue(undefined),
    initiateForceClose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBridge(sessions: FakeSession[], featureFlags = {}) {
  const handlers: { added?: (s: unknown) => void } = {};
  const sessionManager = {
    sessions: Object.assign([...sessions], {
      added: { on: (fn: (s: unknown) => void) => (handlers.added = fn) },
      deleted: { on: () => {} },
    }),
    subscriptionsChanged: { on: () => {} },
  };
  const server = {
    env: {
      get: (key: unknown) =>
        key === SessionManager ? sessionManager : sessionManager,
    },
  };
  const bridge = Object.create(Bridge.prototype) as Bridge;
  Object.assign(bridge as unknown as Record<string, unknown>, {
    server,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    dataProvider: {
      id: "b",
      featureFlags,
      withMetadata: () => ({ id: "b", name: "b" }),
    },
    endpointManager: { root: { parts: { size: 0 } }, failedEntities: [] },
    getExposedDeviceTypes: () => [],
    staleSessionTimers: new Map(),
    sessionStartedAt: new Map(),
    subscribeTimesMs: new WeakMap(),
    giveUpTimesMs: new WeakMap(),
    wedgeHookedSessions: new WeakSet(),
    wedgeLastRotatedAt: new WeakMap(),
    lastImRequestAt: new WeakMap(),
    lastCommandImAt: new WeakMap(),
  });
  (
    bridge as unknown as { wireSessionDiagnostics(): void }
  ).wireSessionDiagnostics();
  return { handlers };
}

describe("Bridge does not close a session that may be priming", () => {
  it("hands the replaced session to the stale timer instead of closing it", () => {
    vi.useFakeTimers();
    const priming = fakeSession(1);
    const { handlers } = makeBridge([priming]);

    handlers.added?.({
      id: 2,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 0 },
    });

    expect(priming.initiateForceClose).not.toHaveBeenCalled();

    priming.subscriptions.size = 1;
    vi.advanceTimersByTime(10 * 60_000);
    expect(priming.initiateForceClose).not.toHaveBeenCalled();
    expect(priming.initiateClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps the grace under fastSessionRecovery", () => {
    vi.useFakeTimers();
    const priming = fakeSession(1);
    const { handlers } = makeBridge([priming], { fastSessionRecovery: true });

    handlers.added?.({
      id: 2,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 0 },
    });

    // That flag arms a 5s timer, a priming report can run past 10s.
    vi.advanceTimersByTime(15_000);
    expect(priming.initiateClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
