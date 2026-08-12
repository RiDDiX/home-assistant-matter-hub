import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("home-assistant-js-websocket", () => ({
  createConnection: vi.fn(),
  createLongLivedTokenAuth: vi.fn(() => ({})),
  getConfig: vi.fn(() => Promise.resolve({ state: "RUNNING" })),
  ERR_INVALID_AUTH: 2,
  ERR_CANNOT_CONNECT: 1,
}));

import {
  createConnection,
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  getConfig,
} from "home-assistant-js-websocket";
import type { LoggerService } from "../../core/app/logger.js";
import {
  HomeAssistantClient,
  isTransientConnectError,
} from "./home-assistant-client.js";

const options = {
  url: "http://ha",
  accessToken: "t",
  refreshInterval: 60,
  messageTimeoutMs: 60_000,
};

function fakeLogger(): LoggerService {
  return {
    get: () => ({
      infoCtx: vi.fn(),
      warnCtx: vi.fn(),
      errorCtx: vi.fn(),
      debugCtx: vi.fn(),
    }),
  } as unknown as LoggerService;
}

describe("isTransientConnectError", () => {
  it("treats ERR_CANNOT_CONNECT as transient", () => {
    expect(isTransientConnectError(ERR_CANNOT_CONNECT)).toBe(true);
  });

  it("treats known socket error codes as transient", () => {
    for (const code of [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
    ]) {
      expect(isTransientConnectError({ code })).toBe(true);
    }
  });

  it("treats socket hang up and TLS errors as transient", () => {
    expect(isTransientConnectError(new Error("socket hang up"))).toBe(true);
    expect(isTransientConnectError(new Error("TLS handshake failed"))).toBe(
      true,
    );
    expect(isTransientConnectError(new Error("tls negotiation"))).toBe(true);
  });

  it("does not retry on auth or unknown errors", () => {
    expect(isTransientConnectError(ERR_INVALID_AUTH)).toBe(false);
    expect(isTransientConnectError({ code: "EACCES" })).toBe(false);
    expect(isTransientConnectError(new Error("bad request"))).toBe(false);
    expect(isTransientConnectError(undefined)).toBe(false);
  });
});

describe("HomeAssistantClient connect/retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createConnection).mockReset();
    vi.mocked(getConfig).mockReset();
    vi.mocked(getConfig).mockResolvedValue({ state: "RUNNING" } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails fast on invalid auth without retrying", async () => {
    vi.mocked(createConnection).mockRejectedValue(ERR_INVALID_AUTH);
    const client = new HomeAssistantClient(fakeLogger(), options);
    const init = client.construction;
    const expectation = expect(init).rejects.toThrow("Authentication failed");
    await vi.runAllTimersAsync();
    await expectation;
    expect(createConnection).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and then connects", async () => {
    const connection = { close: vi.fn(), addEventListener: vi.fn() };
    vi.mocked(createConnection)
      .mockRejectedValueOnce({ code: "ECONNRESET" })
      .mockResolvedValueOnce(connection as never);
    const client = new HomeAssistantClient(fakeLogger(), options);
    const init = client.construction;
    await vi.runAllTimersAsync();
    await expect(init).resolves.toBeUndefined();
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(client.connection).toBe(connection);
  });

  it("throws immediately on a non-transient error", async () => {
    vi.mocked(createConnection).mockRejectedValue(new Error("bad request"));
    const client = new HomeAssistantClient(fakeLogger(), options);
    const init = client.construction;
    const expectation = expect(init).rejects.toThrow(
      "Unable to connect to home assistant",
    );
    await vi.runAllTimersAsync();
    await expectation;
    expect(createConnection).toHaveBeenCalledTimes(1);
  });

  it("gives up after the connect-attempt cap is exhausted", async () => {
    vi.mocked(createConnection).mockRejectedValue({ code: "ECONNRESET" });
    const client = new HomeAssistantClient(fakeLogger(), options);
    const init = client.construction;
    const expectation = expect(init).rejects.toThrow("after 60 attempts");
    await vi.runAllTimersAsync();
    await expectation;
    expect(createConnection).toHaveBeenCalledTimes(60);
  });
});

// The websocket library reconnects on its own without re-checking HA's
// lifecycle, so haRunning must go false on every drop and only return once a
// fresh getConfig poll sees RUNNING (#438).
describe("HomeAssistantClient haRunning", () => {
  let listeners: Record<string, () => void>;
  // biome-ignore lint/suspicious/noExplicitAny: connection stub
  let sendMessage: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createConnection).mockReset();
    vi.mocked(getConfig).mockReset();
    vi.mocked(getConfig).mockResolvedValue({ state: "RUNNING" } as never);
    listeners = {};
    // The running poll goes through sendHaMessage, so it lands on
    // sendMessagePromise rather than the library's getConfig helper.
    sendMessage = vi.fn(async () => ({ state: "RUNNING" }));
    const connection = {
      close: vi.fn(),
      sendMessagePromise: sendMessage,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb;
      }),
    };
    vi.mocked(createConnection).mockResolvedValue(connection as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connectedClient() {
    const client = new HomeAssistantClient(fakeLogger(), options);
    const init = client.construction;
    await vi.runAllTimersAsync();
    await init;
    return client;
  }

  it("is true after connect and false on disconnect", async () => {
    const client = await connectedClient();
    expect(client.haRunning).toBe(true);

    listeners.disconnected();
    expect(client.haRunning).toBe(false);
  });

  it("starts false when the socket dropped right after the RUNNING check", async () => {
    const connection = {
      close: vi.fn(),
      connected: false,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb;
      }),
    };
    vi.mocked(createConnection).mockResolvedValue(connection as never);
    const client = new HomeAssistantClient(fakeLogger(), options);
    const init = client.construction;
    await vi.runAllTimersAsync();
    await init;

    expect(client.haRunning).toBe(false);
  });

  it("stays false on reconnect until HA reports RUNNING again", async () => {
    const client = await connectedClient();
    listeners.disconnected();

    sendMessage.mockResolvedValueOnce({ state: "STARTING" });
    listeners.ready();
    await vi.advanceTimersByTimeAsync(0);
    // First poll saw STARTING: the registry must not be trusted yet.
    expect(client.haRunning).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.haRunning).toBe(true);
  });

  it("keeps polling when HA holds the socket open but never answers", async () => {
    const client = await connectedClient();
    listeners.disconnected();

    // A hung get_config must time out, not park the loop forever.
    sendMessage.mockImplementationOnce(() => new Promise(() => {}));
    listeners.ready();
    await vi.advanceTimersByTimeAsync(options.messageTimeoutMs + 5_000);

    expect(client.haRunning).toBe(true);
  });

  it("stamps runningSince when HA comes back, so the grace outlasts its start", async () => {
    const client = await connectedClient();
    const first = client.runningSince;

    listeners.disconnected();
    await vi.advanceTimersByTimeAsync(60_000);
    listeners.ready();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.runningSince).toBeGreaterThan(first);
  });

  it("a stale running poll never wins over a newer disconnect", async () => {
    const client = await connectedClient();

    let resolveConfig!: (value: unknown) => void;
    sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve: (value: unknown) => void) => {
          resolveConfig = resolve;
        }),
    );
    listeners.ready();
    // The connection drops again while the poll is still in flight.
    listeners.disconnected();
    resolveConfig({ state: "RUNNING" });
    await vi.runAllTimersAsync();

    expect(client.haRunning).toBe(false);
  });
});
