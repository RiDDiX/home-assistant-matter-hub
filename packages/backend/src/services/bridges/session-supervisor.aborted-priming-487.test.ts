import { MessageType } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerModeBridge } from "./server-mode-bridge.js";
import {
  PRIMING_GRACE_MS,
  STALE_SESSION_QUIET_WINDOW_MS,
} from "./session-rotation.js";

// #487: matter.js only adds a subscription to session.subscriptions once its
// initial data reports finished (ServerSubscription.activate). One aborted in
// that window is deleted from a set it never joined, so no subscriptionsChanged
// is emitted. Both recovery paths hung off that event, so the session was never
// reaped and the operational advertisement never resumed. The reporter's node
// stayed silently unreachable for 39 minutes until a manual restart.

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

// A fresh session, exactly as one looks the moment it opens.
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
  const restartAdvertisement = vi.fn();
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
        if (type?.name === "DeviceAdvertiser") return { restartAdvertisement };
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
    .sessions as unknown as { wireSessionDiagnostics(): void };
  // Capture the wrapper the supervisor installs over onNewExchange.
  const before = interactionServer.onNewExchange;
  supervisor.wireSessionDiagnostics();
  const wrapped = interactionServer.onNewExchange;
  onNewExchange = () => {};
  void before;

  // Drive a real SubscribeRequest through the interaction server.
  const subscribeRequest = (session: FakeSession) =>
    wrapped(
      { session } as never,
      {
        payloadHeader: { messageType: MessageType.SubscribeRequest },
      } as never,
    );

  return { handlers, subscribeRequest, restartAdvertisement };
}

// Past the 5 minute quiet window a wedged session must cross, with room for
// the 60s re-arm cycle inside closeStaleSession.
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
    // The abort emits nothing, so nothing else happens on its own.
    expect(session.initiateClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    expect(session.initiateClose).toHaveBeenCalled();
  });

  // Closing the wedged session is only half of it: the operational
  // advertisement stopped when the session opened has to come back, or the
  // controller has no address to rediscover the node through.
  it("re-announces once the wedged session is closed", async () => {
    const session = fakeSession(10885);
    const { subscribeRequest, restartAdvertisement } = makeBridge([session]);

    subscribeRequest(session);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    expect(restartAdvertisement).toHaveBeenCalled();
  });

  it("leaves a session alone once its subscription primes", async () => {
    const session = fakeSession(51913);
    const { handlers, subscribeRequest } = makeBridge([session]);

    subscribeRequest(session);
    // Subscribe successful: the subscription joins the session's set.
    session.subscriptions.size = 1;
    handlers.subscriptionsChanged?.(session as never);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    expect(session.initiateClose).not.toHaveBeenCalled();
  });

  // A controller may hold a session for reads, writes and invokes without ever
  // subscribing. Arming on session open would have closed those.
  it("never touches a session that did not ask to subscribe", async () => {
    const session = fakeSession(30000);
    const { handlers } = makeBridge([session]);

    handlers.added?.(session as never);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    expect(session.initiateClose).not.toHaveBeenCalled();
  });

  // 0 subs but still talking means the peer is recovering, not dead (#287/#398).
  it("keeps a subscribing session that is still talking", async () => {
    const session = fakeSession(20000);
    const { subscribeRequest } = makeBridge([session]);

    subscribeRequest(session);
    // Traffic keeps arriving on the session while it retries.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      session.timestamp = Date.now();
    }

    expect(session.initiateClose).not.toHaveBeenCalled();
  });

  // fastSessionRecovery drops the quiet window to zero, so the 30s priming
  // floor is the only thing keeping a slow-priming session alive. A session
  // still exchanging data must survive it.
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

  // ...but one that goes silent under the same flag is still reaped.
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
