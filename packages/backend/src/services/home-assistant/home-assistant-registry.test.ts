import type { Connection } from "home-assistant-js-websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeAssistantClient } from "./home-assistant-client.js";
import { HomeAssistantRegistry } from "./home-assistant-registry.js";

type Listener = () => void;

function makeConnection(opts?: { initiallyConnected?: boolean }) {
  const listeners: Listener[] = [];
  let connected = opts?.initiallyConnected ?? true;
  const conn = {
    get connected() {
      return connected;
    },
    addEventListener: vi.fn((_: string, cb: Listener) => {
      listeners.push(cb);
    }),
    removeEventListener: vi.fn((_: string, cb: Listener) => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    sendMessagePromise: vi.fn(),
  };
  return {
    connection: conn as unknown as Connection,
    fireReady: () => {
      connected = true;
      for (const cb of listeners.slice()) cb();
    },
    setConnected: (v: boolean) => {
      connected = v;
    },
  };
}

const lostError = () => ({
  type: "result",
  success: false,
  error: { code: 3, message: "Connection lost" },
});

const defaultOptions = {
  url: "http://x",
  accessToken: "t",
  refreshInterval: 60,
  messageTimeoutMs: 60_000,
};

describe("HomeAssistantRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initialize survives a registry fetch that never recovers", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi.fn().mockRejectedValue(lostError());
    const client = { connection: fake.connection } as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, defaultOptions);

    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await expect(initPromise).resolves.toBeUndefined();
    expect(Object.keys(registry.entities)).toHaveLength(0);
    expect(Object.keys(registry.devices)).toHaveLength(0);
  });

  it("recovers within a single attempt when a mid-flight drop is followed by success", async () => {
    const fake = makeConnection();
    let phase = 0;
    fake.connection.sendMessagePromise = vi.fn(() => {
      if (phase === 0) {
        phase = 1;
        return Promise.reject(lostError());
      }
      return Promise.resolve([]);
    }) as unknown as Connection["sendMessagePromise"];
    const client = { connection: fake.connection } as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, defaultOptions);

    const initPromise = registry.construction;
    await vi.advanceTimersByTimeAsync(50);
    fake.setConnected(false);
    fake.fireReady();
    await vi.runAllTimersAsync();
    await expect(initPromise).resolves.toBeUndefined();
  });

  it("propagates non-connection errors to withRetry", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi
      .fn()
      .mockRejectedValue(new Error("bad request"));
    const client = { connection: fake.connection } as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, defaultOptions);

    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await expect(initPromise).resolves.toBeUndefined();
    expect(fake.connection.sendMessagePromise).toHaveBeenCalled();
  });

  it("times out a hung get_states query instead of blocking Promise.all forever", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) => {
      if (message.type === "get_states") {
        // The socket stays open but never answers this one query.
        return new Promise(() => {});
      }
      return Promise.resolve([]);
    }) as unknown as Connection["sendMessagePromise"];
    const client = { connection: fake.connection } as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, {
      ...defaultOptions,
      messageTimeoutMs: 50,
    });
    const internal = registry as unknown as {
      runRegistryQueries(): Promise<boolean>;
    };

    const outcome = internal.runRegistryQueries().then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    // Bounds the assertion in fake-timer time so a still-hanging query fails
    // the expectation cleanly instead of tripping vitest's real-time timeout.
    const probe = new Promise<"hung">((resolve) => {
      setTimeout(() => resolve("hung"), 1000);
    });

    const race = Promise.race([outcome, probe]);
    await vi.runAllTimersAsync();
    await expect(race).resolves.toBe("rejected");
  });
});
