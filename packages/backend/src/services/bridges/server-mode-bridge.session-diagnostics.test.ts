import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import { ServerModeBridge } from "./server-mode-bridge.js";

// #428 parity: bridge.ts emits diagnosticEventBus events on session
// lifecycle (subscription_changed/session_opened/session_closed) and honors
// fastSessionRecovery (#386) for the dead-session timeout. server-mode-bridge.ts
// mirrored the logging but silently dropped both behaviors, so these were red
// before the fix.

type SessionHandler = (session: never) => void;

function makeBridge(
  options: {
    featureFlags?: Record<string, boolean>;
    sessions?: Array<{
      id: number;
      peerNodeId: unknown;
      subscriptions: { size: number };
    }>;
  } = {},
) {
  const logger = {
    get: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  };
  const handlers: {
    subscriptionsChanged?: SessionHandler;
    added?: SessionHandler;
    deleted?: SessionHandler;
  } = {};
  const sessions = Object.assign([...(options.sessions ?? [])], {
    added: { on: (fn: SessionHandler) => (handlers.added = fn) },
    deleted: { on: (fn: SessionHandler) => (handlers.deleted = fn) },
  });
  const sessionManager = {
    sessions,
    subscriptionsChanged: {
      on: (fn: SessionHandler) => (handlers.subscriptionsChanged = fn),
    },
  };
  const server = { env: { get: () => sessionManager } };
  const dataProvider = {
    id: "bridge-1",
    name: "Test Bridge",
    featureFlags: options.featureFlags ?? {},
    withMetadata: () => ({ id: "bridge-1", name: "Test Bridge" }),
  };
  const endpointManager = { devices: [], failedEntities: [] };
  const bridge = new ServerModeBridge(
    logger as never,
    dataProvider as never,
    endpointManager as never,
    server as never,
  );
  (
    bridge as unknown as { wireSessionDiagnostics(): void }
  ).wireSessionDiagnostics();
  return { handlers, bridge };
}

describe("ServerModeBridge session diagnostic events (#428 parity)", () => {
  it("emits subscription_changed", () => {
    const { handlers } = makeBridge();
    const seen: string[] = [];
    const unsubscribe = diagnosticEventBus.subscribe((e) => seen.push(e.type));
    handlers.subscriptionsChanged?.({
      id: 1,
      peerNodeId: 10n,
      subscriptions: { size: 2 },
    } as never);
    unsubscribe();
    expect(seen).toContain("subscription_changed");
  });

  it("emits session_opened", () => {
    const { handlers } = makeBridge();
    const seen: string[] = [];
    const unsubscribe = diagnosticEventBus.subscribe((e) => seen.push(e.type));
    handlers.added?.({
      id: 2,
      peerNodeId: 20n,
      fabric: { fabricIndex: 1 },
    } as never);
    unsubscribe();
    expect(seen).toContain("session_opened");
  });

  it("emits session_closed", () => {
    const { handlers } = makeBridge();
    const seen: string[] = [];
    const unsubscribe = diagnosticEventBus.subscribe((e) => seen.push(e.type));
    handlers.deleted?.({ id: 3, peerNodeId: 30n } as never);
    unsubscribe();
    expect(seen).toContain("session_closed");
  });
});

describe("ServerModeBridge dead-session timeout honors fastSessionRecovery (#386 parity)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules the 60s default without the flag", () => {
    const zeroSubSession = {
      id: 1,
      peerNodeId: 10n,
      subscriptions: { size: 0 },
    };
    const { handlers } = makeBridge({ sessions: [zeroSubSession] });
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((() => 0) as unknown as typeof setTimeout);

    handlers.subscriptionsChanged?.(zeroSubSession as never);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it("schedules the 5s timeout when fastSessionRecovery is on", () => {
    const zeroSubSession = {
      id: 1,
      peerNodeId: 10n,
      subscriptions: { size: 0 },
    };
    const { handlers } = makeBridge({
      featureFlags: { fastSessionRecovery: true },
      sessions: [zeroSubSession],
    });
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((() => 0) as unknown as typeof setTimeout);

    handlers.subscriptionsChanged?.(zeroSubSession as never);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
  });
});

// A subscription only joins session.subscriptions once its priming report
// finished, so a controller still being interviewed looks identical to a dead
// session. Closing it there aborted the commissioning (#424 class).
describe("ServerModeBridge does not close a session that may be priming", () => {
  it("hands the replaced session to the stale timer instead of force closing", () => {
    vi.useFakeTimers();
    const priming = {
      id: 1,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      isClosing: false,
      subscriptions: { size: 0 },
      initiateClose: vi.fn().mockResolvedValue(undefined),
      initiateForceClose: vi.fn().mockResolvedValue(undefined),
    };
    const { handlers } = makeBridge({ sessions: [priming as never] });

    handlers.added?.({
      id: 2,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 0 },
    } as never);

    expect(priming.initiateForceClose).not.toHaveBeenCalled();
    expect(priming.initiateClose).not.toHaveBeenCalled();

    // Priming finishes, so the timer must leave it alone when it fires.
    priming.subscriptions.size = 1;
    vi.advanceTimersByTime(10 * 60_000);
    expect(priming.initiateForceClose).not.toHaveBeenCalled();
    expect(priming.initiateClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("replaces a shorter timer that was already armed", () => {
    vi.useFakeTimers();
    const priming = {
      id: 1,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      isClosing: false,
      isPeerActive: false,
      timestamp: Date.now(),
      subscriptions: { size: 0 },
      initiateClose: vi.fn().mockResolvedValue(undefined),
      initiateForceClose: vi.fn().mockResolvedValue(undefined),
    };
    const { handlers } = makeBridge({
      sessions: [priming as never],
      featureFlags: { fastSessionRecovery: true },
    });

    // The session lost its subscriptions first, which arms the 5s timer.
    handlers.subscriptionsChanged?.(priming as never);
    // Then the controller re-CASEs and starts priming on the new session.
    handlers.added?.({
      id: 2,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 0 },
    } as never);

    vi.advanceTimersByTime(15_000);
    expect(priming.initiateClose).not.toHaveBeenCalled();
    expect(priming.initiateForceClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("still keeps a session that is priming past the grace", () => {
    vi.useFakeTimers();
    const priming = {
      id: 1,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      isClosing: false,
      // isPeerActive covers only a few seconds, the traffic stamp is what
      // says the interview is still running
      isPeerActive: false,
      // the peer keeps acking priming chunks, so its traffic stamp stays fresh
      get timestamp() {
        return Date.now();
      },
      subscriptions: { size: 0 },
      initiateClose: vi.fn().mockResolvedValue(undefined),
      initiateForceClose: vi.fn().mockResolvedValue(undefined),
    };
    const { handlers } = makeBridge({
      sessions: [priming as never],
      featureFlags: { fastSessionRecovery: true },
    });

    handlers.added?.({
      id: 2,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 0 },
    } as never);

    // Well past the 30s grace, still interviewing.
    vi.advanceTimersByTime(60_000);

    expect(priming.initiateClose).not.toHaveBeenCalled();
    expect(priming.initiateForceClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("gives priming its grace even with fastSessionRecovery on", () => {
    vi.useFakeTimers();
    const priming = {
      id: 1,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      isClosing: false,
      // mid-priming: no subscription yet, and the peer is only sending acks
      isPeerActive: false,
      timestamp: Date.now(),
      subscriptions: { size: 0 },
      initiateClose: vi.fn().mockResolvedValue(undefined),
      initiateForceClose: vi.fn().mockResolvedValue(undefined),
    };
    const { handlers } = makeBridge({
      sessions: [priming as never],
      featureFlags: { fastSessionRecovery: true },
    });

    handlers.added?.({
      id: 2,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 0 },
    } as never);

    // That flag arms a 5s timer with no quiet window, but a priming report
    // can run past 10s.
    vi.advanceTimersByTime(15_000);
    expect(priming.initiateClose).not.toHaveBeenCalled();

    priming.subscriptions.size = 1;
    vi.advanceTimersByTime(10 * 60_000);
    expect(priming.initiateClose).not.toHaveBeenCalled();
    expect(priming.initiateForceClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("drops the timer when the session is deleted", () => {
    vi.useFakeTimers();
    const gone = {
      id: 1,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      isClosing: false,
      isPeerActive: false,
      timestamp: Date.now(),
      subscriptions: { size: 0 },
      initiateClose: vi.fn().mockResolvedValue(undefined),
      initiateForceClose: vi.fn().mockResolvedValue(undefined),
    };
    const { handlers, bridge } = makeBridge({ sessions: [gone as never] });

    handlers.added?.({
      id: 2,
      peerNodeId: 10n,
      fabric: { fabricIndex: 1 },
      subscriptions: { size: 0 },
    } as never);
    const timers = (
      bridge as unknown as { staleSessionTimers: Map<number, unknown> }
    ).staleSessionTimers;
    expect(timers.has(1)).toBe(true);

    handlers.deleted?.(gone as never);
    expect(timers.has(1)).toBe(false);
    vi.useRealTimers();
  });
});
