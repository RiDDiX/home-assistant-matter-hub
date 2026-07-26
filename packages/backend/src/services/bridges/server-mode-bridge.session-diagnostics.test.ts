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
  return { handlers };
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
