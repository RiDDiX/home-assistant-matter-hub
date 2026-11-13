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

function makeSupervisor(
  sessions: FakeSession[],
  featureFlags: object = {},
  provider: object = {},
) {
  const handlers: {
    subscriptionsChanged?: Handler;
    added?: Handler;
    deleted?: Handler;
    fabricAdded?: Handler;
  } = {};
  // every handler currently on each event, to catch stacked or leaked ones
  const registered: Record<string, Set<Handler>> = {};
  const event = (name: keyof typeof handlers) => {
    const fns = new Set<Handler>();
    registered[name] = fns;
    return {
      on: (fn: Handler) => {
        handlers[name] = fn;
        fns.add(fn);
      },
      off: (fn: Handler) => fns.delete(fn),
    };
  };
  const imOriginal = vi.fn((_e: unknown, _m: unknown) => {});
  const interactionServer = { onNewExchange: imOriginal };
  const list = Object.assign(sessions, {
    added: event("added"),
    deleted: event("deleted"),
  });
  const sessionManager = {
    sessions: list,
    subscriptionsChanged: event("subscriptionsChanged"),
  };
  const fabricManager = { events: { added: event("fabricAdded") } };
  const env = {
    get: (type: { name?: string }) =>
      type?.name === "InteractionServer"
        ? interactionServer
        : type?.name === "FabricManager"
          ? fabricManager
          : sessionManager,
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sup = new SessionSupervisor(
    log as never,
    { env } as never,
    { id: "b", featureFlags, ...provider } as unknown as BridgeDataProvider,
    () => ({ id: "b", name: "b" }),
    0,
  );
  const internals = sup as unknown as {
    wireSessionDiagnostics(): void;
    startWedgeWatchdog(): void;
    staleSessionTimers: Map<number, unknown>;
    deadSessionTimer: unknown;
    rotationTimer: unknown;
    wedgeWatchdogTimer: unknown;
    mdnsAddressTimer: unknown;
  };
  internals.wireSessionDiagnostics();
  const imRequest = (session: FakeSession, messageType: number) =>
    interactionServer.onNewExchange(
      { session } as never,
      { payloadHeader: { messageType } } as never,
    );
  return {
    sup,
    internals,
    handlers,
    registered,
    list,
    imRequest,
    interactionServer,
    imOriginal,
    log,
  };
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

  it("throttles the replacement session of a rotated peer, not another peer", async () => {
    const older = fakeSession(1, 1);
    const { internals, handlers, list } = makeSupervisor([older], {
      wedgeWatchdog: true,
    });
    internals.startWedgeWatchdog();
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(older.initiateClose).toHaveBeenCalled();

    list.splice(0);
    handlers.deleted?.(older as never);
    const newer = fakeSession(2, 1);
    const other = fakeSession(3, 1);
    other.peerNodeId = 98n;
    for (const s of [newer, other]) {
      list.push(s);
      handlers.added?.(s as never);
    }

    // both are wedged 50min later, only the other peer may rotate yet
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(other.initiateClose).toHaveBeenCalled();
    expect(newer.initiateClose).not.toHaveBeenCalled();
    // the first check past the minimum interval since the rotation
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(newer.initiateClose).toHaveBeenCalled();
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

describe("lifecycle", () => {
  const timed = () =>
    makeSupervisor([], { wedgeWatchdog: true }, { sessionMaxAgeHours: 1 });

  it("reconfigure after stop arms no timer", () => {
    const { sup } = timed();
    sup.start();
    sup.stop();
    sup.reconfigure();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconfigure before start arms no timer", () => {
    timed().sup.reconfigure();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconfigure while running re-arms the timers", () => {
    const { sup, internals } = timed();
    sup.start();
    const count = vi.getTimerCount();
    const { rotationTimer, wedgeWatchdogTimer } = internals;
    sup.reconfigure();
    expect(vi.getTimerCount()).toBe(count);
    expect(internals.rotationTimer).not.toBe(rotationTimer);
    expect(internals.wedgeWatchdogTimer).not.toBe(wedgeWatchdogTimer);
  });

  it("start twice then stop leaves no handler and no timer", () => {
    const { sup, registered } = timed();
    sup.start();
    sup.start();
    for (const fns of Object.values(registered)) expect(fns.size).toBe(1);
    sup.stop();
    for (const fns of Object.values(registered)) expect(fns.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns once per added Alexa fabric after a second start", () => {
    const { sup, registered, log } = makeSupervisor([], {}, { port: 5541 });
    sup.start();
    sup.start();
    for (const fn of registered.fabricAdded)
      fn({ rootVendorId: 4631 } as never);
    const warns = log.warn.mock.calls.filter((c) =>
      String(c[0]).includes("Fabric added by Amazon Alexa"),
    );
    expect(warns).toHaveLength(1);
  });

  it("stop clears the mdns address watch", () => {
    const { sup, internals } = makeSupervisor([]);
    sup.start();
    expect(internals.mdnsAddressTimer).not.toBeNull();
    sup.stop();
    expect(internals.mdnsAddressTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms the dead session timer at zero subscriptions, cancels it on recovery", () => {
    const s = fakeSession(1);
    s.timestamp = Time.nowUs - STALE_SESSION_QUIET_WINDOW_MS;
    const { handlers, internals } = makeSupervisor([s]);

    handlers.subscriptionsChanged?.(s as never);
    expect(internals.deadSessionTimer).not.toBeNull();
    s.subscriptions.size = 1;
    handlers.subscriptionsChanged?.(s as never);
    expect(internals.deadSessionTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the original request handler when the bookkeeping throws", () => {
    const { interactionServer, imOriginal } = makeSupervisor([]);
    const exchange = { session: fakeSession(1) };
    const message = {
      get payloadHeader(): never {
        throw new Error("boom");
      },
    };
    interactionServer.onNewExchange(exchange, message);
    // compared by identity, a deep compare would hit the throwing getter
    expect(imOriginal).toHaveBeenCalledOnce();
    expect(imOriginal.mock.calls[0][0]).toBe(exchange);
    expect(imOriginal.mock.calls[0][1]).toBe(message);
  });
});
