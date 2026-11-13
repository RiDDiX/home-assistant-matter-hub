import { Time } from "@matter/general";
import { MessageType } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerModeBridge } from "./server-mode-bridge.js";
import {
  DEAD_SESSION_TIMEOUT_MS,
  deadSessionTimeoutMs,
  FAST_DEAD_SESSION_TIMEOUT_MS,
  PRIMING_GRACE_MS,
  STALE_SESSION_QUIET_WINDOW_MS,
} from "./session-rotation.js";

// #487: a subscription that died during its first reports left the session
// wedged, nothing reaped it or re-announced until a restart.

type Handler = (session: never) => void;

interface FakeSession {
  id: number;
  peerNodeId: unknown;
  subscriptions: { size: number };
  isClosing: boolean;
  timestamp: number;
  isPeerActive: boolean;
  fabric?: { fabricIndex: number };
  initiateClose: ReturnType<typeof vi.fn>;
  initiateForceClose: ReturnType<typeof vi.fn>;
}

function fakeSession(id: number): FakeSession {
  return {
    id,
    peerNodeId: 99n,
    subscriptions: { size: 0 },
    isClosing: false,
    timestamp: Date.now(),
    isPeerActive: false,
    fabric: { fabricIndex: 1 },
    initiateClose: vi.fn(async () => {}),
    initiateForceClose: vi.fn(async () => {}),
  };
}

function makeBridge(sessions: FakeSession[], featureFlags: object = {}) {
  const handlers: { subscriptionsChanged?: Handler; added?: Handler } = {};
  let onNewExchange = (_e: unknown, _m: unknown) => {};
  const interactionServer = {
    onNewExchange: (e: unknown, m: unknown) => onNewExchange(e, m),
  };
  const list = Object.assign(sessions, {
    added: { on: (fn: Handler) => (handlers.added = fn) },
    deleted: { on: () => {} },
  });
  const sessionManager = {
    sessions: list,
    subscriptionsChanged: {
      on: (fn: Handler) => (handlers.subscriptionsChanged = fn),
    },
  };
  const server = {
    env: {
      get: (type: { name?: string }) => {
        if (type?.name === "InteractionServer") return interactionServer;
        return sessionManager;
      },
    },
  };
  const bridge = new ServerModeBridge(
    {
      get: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    } as never,
    {
      id: "bridge-1",
      name: "Test Bridge",
      featureFlags,
      withMetadata: () => ({ id: "bridge-1", name: "Test Bridge" }),
    } as never,
    { devices: [], failedEntities: [] } as never,
    server as never,
  );
  const supervisor = (bridge as unknown as { sessions: unknown })
    .sessions as unknown as {
    wireSessionDiagnostics(): void;
    stop(): void;
    stopped: boolean;
    staleSessionTimers: Map<number, unknown>;
  };
  const before = interactionServer.onNewExchange;
  // stands in for start() without its rotation and watchdog intervals
  supervisor.stopped = false;
  supervisor.wireSessionDiagnostics();
  const wrapped = interactionServer.onNewExchange;
  onNewExchange = () => {};
  void before;

  const subscribeRequest = (session: FakeSession) =>
    wrapped(
      { session } as never,
      {
        payloadHeader: { messageType: MessageType.SubscribeRequest },
      } as never,
    );

  return { handlers, subscribeRequest, supervisor };
}

// past the 5 min quiet window plus a 60s re-arm
const PAST_QUIET_MS =
  STALE_SESSION_QUIET_WINDOW_MS + PRIMING_GRACE_MS + 120_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("subscription aborted during initial data reports (#487)", () => {
  it("reaps a session whose subscription never established", async () => {
    const session = fakeSession(10885);
    const { subscribeRequest } = makeBridge([session]);

    subscribeRequest(session);
    expect(session.initiateClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    expect(session.initiateClose).toHaveBeenCalled();
  });

  it("leaves a session alone once its subscription primes", async () => {
    const session = fakeSession(51913);
    const { handlers, subscribeRequest } = makeBridge([session]);

    subscribeRequest(session);
    session.subscriptions.size = 1;
    handlers.subscriptionsChanged?.(session as never);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    expect(session.initiateClose).not.toHaveBeenCalled();
  });

  it("never touches a session that did not ask to subscribe", async () => {
    const session = fakeSession(30000);
    const { handlers } = makeBridge([session]);

    handlers.added?.(session as never);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    expect(session.initiateClose).not.toHaveBeenCalled();
  });

  // a session still talking is recovering (#287)
  it("keeps a subscribing session that is still talking", async () => {
    const session = fakeSession(20000);
    const { subscribeRequest } = makeBridge([session]);

    subscribeRequest(session);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      session.timestamp = Date.now();
    }

    expect(session.initiateClose).not.toHaveBeenCalled();
  });

  // fastSessionRecovery drops the quiet window to the 30s priming floor
  it("does not cut off a slow prime under fastSessionRecovery", async () => {
    const session = fakeSession(40000);
    const { subscribeRequest } = makeBridge([session], {
      fastSessionRecovery: true,
    });

    subscribeRequest(session);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      session.timestamp = Date.now();
    }

    expect(session.initiateClose).not.toHaveBeenCalled();
  });

  it("arms no watchdog for a SubscribeRequest that lands after stop()", () => {
    const session = fakeSession(50000);
    const { subscribeRequest, supervisor } = makeBridge([session]);

    supervisor.stop();
    subscribeRequest(session);

    expect(supervisor.staleSessionTimers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still reaps a wedged session under fastSessionRecovery", async () => {
    const session = fakeSession(40001);
    const { subscribeRequest } = makeBridge([session], {
      fastSessionRecovery: true,
    });

    subscribeRequest(session);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    expect(session.initiateClose).toHaveBeenCalled();
  });
});

// matter.js reports on the peer's newest session, so an older session that
// owns a live subscription goes quiet. A new CASE must not kill it.
describe("older session holding a subscription on a new session", () => {
  for (const fastSessionRecovery of [false, true]) {
    it(`keeps it until matter.js drops the sub (fastSessionRecovery=${fastSessionRecovery})`, async () => {
      const older = fakeSession(1);
      older.subscriptions.size = 1;
      older.timestamp = Time.nowUs - STALE_SESSION_QUIET_WINDOW_MS - 60_000;
      const current = fakeSession(2);
      current.subscriptions.size = 1;
      const fresh = fakeSession(3);
      fresh.subscriptions.size = 1;
      const { handlers } = makeBridge([older, current, fresh], {
        fastSessionRecovery,
      });

      handlers.added?.(fresh as never);
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(older.initiateClose).not.toHaveBeenCalled();

      older.subscriptions.size = 0;
      handlers.subscriptionsChanged?.(older as never);
      const timeoutMs = deadSessionTimeoutMs({ fastSessionRecovery });
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(older.initiateClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(older.initiateClose).toHaveBeenCalled();
      expect(current.initiateClose).not.toHaveBeenCalled();
      expect(fresh.initiateClose).not.toHaveBeenCalled();
    });
  }
});

// A 5s fastSessionRecovery stale timer must not cut a SubscribeRequest short.
describe("SubscribeRequest on a session with a stale timer armed", () => {
  it("applies the priming floor under fastSessionRecovery", async () => {
    const session = fakeSession(60000);
    session.timestamp = Time.nowUs;
    const { handlers, subscribeRequest } = makeBridge([session], {
      fastSessionRecovery: true,
    });

    handlers.subscriptionsChanged?.(session as never);
    await vi.advanceTimersByTimeAsync(1_000);
    session.timestamp = Time.nowUs;
    subscribeRequest(session);

    await vi.advanceTimersByTimeAsync(FAST_DEAD_SESSION_TIMEOUT_MS);
    expect(session.initiateClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(
      PRIMING_GRACE_MS - FAST_DEAD_SESSION_TIMEOUT_MS - 1,
    );
    expect(session.initiateClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.initiateClose).toHaveBeenCalled();
  });

  it("replaces the armed timer and lets the quiet window decide by default", async () => {
    const session = fakeSession(60001);
    session.timestamp = Time.nowUs;
    const { handlers, subscribeRequest, supervisor } = makeBridge([session]);

    handlers.subscriptionsChanged?.(session as never);
    const armed = supervisor.staleSessionTimers.get(session.id);
    expect(armed).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    subscribeRequest(session);
    expect(supervisor.staleSessionTimers.get(session.id)).toBeDefined();
    expect(supervisor.staleSessionTimers.get(session.id)).not.toBe(armed);

    await vi.advanceTimersByTimeAsync(STALE_SESSION_QUIET_WINDOW_MS - 10_000);
    expect(session.initiateClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEAD_SESSION_TIMEOUT_MS + 10_000);
    expect(session.initiateClose).toHaveBeenCalled();
  });
});
