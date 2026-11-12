import { Time } from "@matter/general";
import { MessageType } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import {
  DEAD_SESSION_TIMEOUT_MS,
  PRIMING_GRACE_MS,
  STALE_SESSION_QUIET_WINDOW_MS,
} from "./session-rotation.js";
import { SessionSupervisor } from "./session-supervisor.js";
import { WEDGE_IM_SILENCE_MS } from "./wedge-watchdog.js";

type Handler = (session: never) => void;

interface FakeSession {
  id: number;
  peerNodeId: unknown;
  subscriptions: { size: number; [Symbol.iterator](): Iterator<never> };
  isClosing: boolean;
  timestamp: number;
  isPeerActive: boolean;
  fabric: { fabricIndex: number };
  initiateClose: ReturnType<typeof vi.fn>;
  initiateForceClose: ReturnType<typeof vi.fn>;
  closeSubscriptions: ReturnType<typeof vi.fn>;
}

function fakeSession(id: number, subs = 0): FakeSession {
  return {
    id,
    peerNodeId: 99n,
    subscriptions: {
      size: subs,
      [Symbol.iterator]: () => [][Symbol.iterator](),
    },
    isClosing: false,
    timestamp: Time.nowUs,
    isPeerActive: false,
    fabric: { fabricIndex: 1 },
    initiateClose: vi.fn(async () => {}),
    initiateForceClose: vi.fn(async () => {}),
    closeSubscriptions: vi.fn(async () => 0),
  };
}

function makeSupervisor(sessions: FakeSession[], featureFlags: object = {}) {
  const handlers: {
    subscriptionsChanged?: Handler;
    added?: Handler;
    deleted?: Handler;
  } = {};
  const interactionServer = {
    onNewExchange: (_e: unknown, _m: unknown) => {},
  };
  const list = Object.assign(sessions, {
    added: { on: (fn: Handler) => (handlers.added = fn), off() {} },
    deleted: { on: (fn: Handler) => (handlers.deleted = fn), off() {} },
  });
  const sessionManager = {
    sessions: list,
    subscriptionsChanged: {
      on: (fn: Handler) => (handlers.subscriptionsChanged = fn),
      off() {},
    },
  };
  const env = {
    get: (type: { name?: string }) =>
      type?.name === "InteractionServer" ? interactionServer : sessionManager,
  };
  const sup = new SessionSupervisor(
    { debug() {}, info() {}, warn() {}, error() {} } as never,
    { env } as never,
    { id: "b", featureFlags } as unknown as BridgeDataProvider,
    () => ({ id: "b", name: "b" }),
    0,
  );
  const internals = sup as unknown as {
    wireSessionDiagnostics(): void;
    startWedgeWatchdog(): void;
    staleSessionTimers: Map<number, unknown>;
  };
  internals.wireSessionDiagnostics();
  const imRequest = (session: FakeSession, messageType: number) =>
    interactionServer.onNewExchange(
      { session } as never,
      { payloadHeader: { messageType } } as never,
    );
  return { sup, internals, handlers, list, imRequest };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stale session keep and re-arm", () => {
  it("keeps a 0-sub session while it talks, closes it once quiet", async () => {
    const s = fakeSession(1);
    const { handlers } = makeSupervisor([s]);

    handlers.subscriptionsChanged?.(s as never);
    await vi.advanceTimersByTimeAsync(100_000);
    s.timestamp = Time.nowUs;

    // re-checks every 60s, the first one 300s past the last traffic is t=420s
    await vi.advanceTimersByTimeAsync(310_000);
    expect(s.initiateClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.initiateClose).toHaveBeenCalled();
  });
});

describe("dead session cleanup", () => {
  it("closes a quiet 0-sub session and re-checks a kept one", async () => {
    const lost = fakeSession(1);
    lost.timestamp = Time.nowUs - STALE_SESSION_QUIET_WINDOW_MS;
    const idle = fakeSession(2);
    const { handlers } = makeSupervisor([lost, idle]);

    handlers.subscriptionsChanged?.(lost as never);
    await vi.advanceTimersByTimeAsync(DEAD_SESSION_TIMEOUT_MS);
    expect(lost.initiateClose).toHaveBeenCalled();
    expect(idle.initiateClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(
      STALE_SESSION_QUIET_WINDOW_MS - DEAD_SESSION_TIMEOUT_MS - 1,
    );
    expect(idle.initiateClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(idle.initiateClose).toHaveBeenCalled();
  });
});

describe("0-sub session replaced by a new session", () => {
  it("closes it once quiet, not before", async () => {
    const old = fakeSession(1);
    const fresh = fakeSession(2, 1);
    const { handlers } = makeSupervisor([old, fresh]);

    handlers.added?.(fresh as never);
    await vi.advanceTimersByTimeAsync(STALE_SESSION_QUIET_WINDOW_MS - 1);
    expect(old.initiateClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(old.initiateClose).toHaveBeenCalled();
    expect(fresh.initiateClose).not.toHaveBeenCalled();
  });

  it("waits the priming floor under fastSessionRecovery", async () => {
    const old = fakeSession(1);
    const fresh = fakeSession(2, 1);
    const { handlers } = makeSupervisor([old, fresh], {
      fastSessionRecovery: true,
    });

    handlers.added?.(fresh as never);
    await vi.advanceTimersByTimeAsync(PRIMING_GRACE_MS - 1);
    expect(old.initiateClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(old.initiateClose).toHaveBeenCalled();
  });
});

describe("session deleted", () => {
  it("clears its stale timer", async () => {
    const s = fakeSession(1);
    s.timestamp = Time.nowUs - STALE_SESSION_QUIET_WINDOW_MS;
    const { handlers, internals, list } = makeSupervisor([s]);

    handlers.subscriptionsChanged?.(s as never);
    expect(internals.staleSessionTimers.has(1)).toBe(true);
    list.splice(0);
    handlers.deleted?.(s as never);
    expect(internals.staleSessionTimers.size).toBe(0);
  });
});

describe("wedge watchdog", () => {
  function setup(wedgeWatchdog: boolean) {
    const wedged = fakeSession(1, 1);
    const active = fakeSession(2, 1);
    active.peerNodeId = 98n;
    const younger = fakeSession(3, 1);
    const sessions = [wedged, active];
    const ctx = makeSupervisor(sessions, { wedgeWatchdog });
    ctx.internals.startWedgeWatchdog();
    return { ...ctx, wedged, active, younger };
  }

  it("closes nothing with the flag off", async () => {
    const { wedged, active } = setup(false);

    await vi.advanceTimersByTimeAsync(2 * WEDGE_IM_SILENCE_MS);

    expect(wedged.initiateClose).not.toHaveBeenCalled();
    expect(active.initiateClose).not.toHaveBeenCalled();
  });

  it("spares a younger and a recently active session", async () => {
    const { wedged, active, younger, handlers, list, imRequest } = setup(true);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    list.push(younger);
    handlers.added?.(younger as never);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    imRequest(active, MessageType.ReadRequest);

    // t=45min is not past the silence threshold, the 50min check is
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(wedged.initiateClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(wedged.initiateClose).toHaveBeenCalled();
    expect(active.initiateClose).not.toHaveBeenCalled();
    expect(younger.initiateClose).not.toHaveBeenCalled();
  });
});

describe("wedge watchdog per peer", () => {
  // older owns the subscription, the peer talks on newer
  async function olderRotated(newer: FakeSession, request: boolean) {
    const older = fakeSession(1, 1);
    const { internals, handlers, list, imRequest } = makeSupervisor([older], {
      wedgeWatchdog: true,
    });
    internals.startWedgeWatchdog();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    list.push(newer);
    handlers.added?.(newer as never);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    if (request) imRequest(newer, MessageType.ReadRequest);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    return older.initiateClose.mock.calls.length > 0;
  }

  it("spares an older session while the peer talks on a newer one", async () => {
    expect(await olderRotated(fakeSession(2), true)).toBe(false);
  });

  it("rotates it when the peer is silent on all its sessions", async () => {
    expect(await olderRotated(fakeSession(2), false)).toBe(true);
  });

  it("does not count a request from another peer", async () => {
    const other = fakeSession(2);
    other.peerNodeId = 98n;
    expect(await olderRotated(other, true)).toBe(true);
  });

  it("does not count a request on another fabric", async () => {
    const other = fakeSession(2);
    other.fabric = { fabricIndex: 2 };
    expect(await olderRotated(other, true)).toBe(true);
  });

  // older carries the full v2 churn signature, the peer invokes on newer
  async function olderV2Flagged(request: boolean) {
    const older = fakeSession(1, 1);
    const newer = fakeSession(2);
    const { sup, internals, handlers, list, imRequest } = makeSupervisor([
      older,
    ]);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    list.push(newer);
    handlers.added?.(newer as never);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    if (request) imRequest(newer, MessageType.InvokeRequest);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const now = Date.now();
    const rings = internals as unknown as {
      subscribeTimesMs: WeakMap<object, number[]>;
      giveUpTimesMs: WeakMap<object, number[]>;
    };
    rings.subscribeTimesMs.set(older, [now - 20, now - 15, now - 10]);
    rings.giveUpTimesMs.set(older, [now - 12, now - 5]);
    return sup.getSessionInfo().sessions.find((s) => s.id === 1)
      ?.wedgeV2WouldRotate;
  }

  it("v2 spares an older session while the peer invokes on a newer one", async () => {
    expect(await olderV2Flagged(true)).toBe(false);
  });

  it("v2 flags it when the peer is command silent on all its sessions", async () => {
    expect(await olderV2Flagged(false)).toBe(true);
  });
});
