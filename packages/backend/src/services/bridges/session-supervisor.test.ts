import type { Environment, Logger } from "@matter/general";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import { DEFAULT_SESSION_MAX_AGE_HOURS } from "./session-rotation.js";
import { SessionSupervisor } from "./session-supervisor.js";

// With no configured max age both bridge types keep rotation off (#287).
// Server mode passes DEFAULT_SESSION_MAX_AGE_HOURS, the aggregator 0.

function supervisor(
  defaultHours: number,
  sessionMaxAgeHours?: number,
  env = {} as Environment,
) {
  const warn = vi.fn();
  const sup = new SessionSupervisor(
    { debug() {}, info() {}, warn, error() {} } as unknown as Logger,
    { env },
    {
      id: "b",
      featureFlags: {},
      sessionMaxAgeHours,
    } as unknown as BridgeDataProvider,
    () => ({ id: "b", name: "b" }),
    defaultHours,
  );
  const read = () =>
    (
      sup as unknown as { readSessionMaxAgeHours(): number }
    ).readSessionMaxAgeHours();
  return { sup, read, warn };
}

describe("SessionSupervisor rotation default", () => {
  afterEach(() => {
    delete process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS;
  });

  it("aggregator bridge: unset env keeps rotation off", () => {
    delete process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS;
    expect(supervisor(0).read()).toBe(0);
  });

  it("server mode: unset env keeps rotation off too", () => {
    delete process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS;
    expect(supervisor(DEFAULT_SESSION_MAX_AGE_HOURS).read()).toBe(0);
  });

  it("garbage env warns and keeps rotation off", () => {
    process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS = "nope";
    const { read, warn } = supervisor(DEFAULT_SESSION_MAX_AGE_HOURS);
    expect(read()).toBe(0);
    expect(warn.mock.calls[0][0]).toContain("disabling session rotation");
  });

  it("a configured value or the env var still turns it on", () => {
    process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS = "nope";
    expect(supervisor(0, 12).read()).toBe(12);
    expect(supervisor(DEFAULT_SESSION_MAX_AGE_HOURS, 0).read()).toBe(0);
    process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS = "6";
    expect(supervisor(DEFAULT_SESSION_MAX_AGE_HOURS).read()).toBe(6);
  });
});

describe("SessionSupervisor graceful close", () => {
  // Real initiateClose runs the shutdown logic before it may defer the close.
  function fakeSession() {
    const order: string[] = [];
    return {
      order,
      id: 7,
      peerNodeId: 1n,
      isClosing: false,
      subscriptions: { size: 2 },
      closeSubscriptions: vi.fn(async (_flush?: boolean) => {
        order.push("subs");
        return 2;
      }),
      initiateClose: vi.fn(async (logic?: () => Promise<void>) => {
        await logic?.();
        order.push("close");
      }),
      initiateForceClose: vi.fn(async () => {}),
    };
  }

  function withSession(s: ReturnType<typeof fakeSession>) {
    const env = { get: () => ({ sessions: [s] }) } as unknown as Environment;
    return supervisor(0, 1, env).sup as unknown as {
      sessionStartedAt: Map<number, number>;
      maxSessionAgeMs: number;
      rotateAgedSessions(): void;
      closeActiveSessions(): Promise<void>;
    };
  }

  it("age rotation flushes and closes subscriptions before the session", async () => {
    const s = fakeSession();
    const sup = withSession(s);
    sup.maxSessionAgeMs = 60_000;
    sup.sessionStartedAt.set(s.id, Date.now() - 120_000);
    sup.rotateAgedSessions();
    await vi.waitFor(() => expect(s.order).toEqual(["subs", "close"]));
    expect(s.closeSubscriptions).toHaveBeenCalledWith(true);
    expect(s.initiateForceClose).not.toHaveBeenCalled();
  });

  it("shutdown close does the same", async () => {
    const s = fakeSession();
    await withSession(s).closeActiveSessions();
    expect(s.order).toEqual(["subs", "close"]);
    expect(s.closeSubscriptions).toHaveBeenCalledWith(true);
  });
});

describe("SessionSupervisor stale session re-arm", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-arming the same session keeps one timer", async () => {
    vi.useFakeTimers();
    const s = {
      id: 9,
      peerNodeId: 1n,
      isClosing: false,
      isPeerActive: false,
      timestamp: Date.now(),
      subscriptions: { size: 0 },
      initiateClose: vi.fn(async () => {}),
      initiateForceClose: vi.fn(async () => {}),
    };
    const env = { get: () => ({ sessions: [s] }) } as unknown as Environment;
    const sup = supervisor(0, 0, env).sup as unknown as {
      closeStaleSession(id: number): void;
    };
    sup.closeStaleSession(s.id);
    sup.closeStaleSession(s.id);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.initiateClose).toHaveBeenCalledTimes(1);
  });
});
