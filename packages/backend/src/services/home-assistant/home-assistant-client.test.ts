import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("home-assistant-js-websocket", () => ({
  createConnection: vi.fn(),
  createLongLivedTokenAuth: vi.fn(() => ({})),
  getConfig: vi.fn(() => Promise.resolve({ state: "RUNNING" })),
  getUser: vi.fn(() => Promise.resolve({ name: "admin", is_admin: true })),
  ERR_INVALID_AUTH: 2,
  ERR_CANNOT_CONNECT: 1,
}));

import {
  createConnection,
  createLongLivedTokenAuth,
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  getConfig,
  getUser,
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
    await vi.advanceTimersByTimeAsync(10_000);
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
    await vi.advanceTimersByTimeAsync(5_000);
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
    await vi.advanceTimersByTimeAsync(5_000);
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
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.haRunning).toBe(false);
  });
});

describe("home-assistant-js-websocket internals", () => {
  it("finds the library-private Connection._setSocket", async () => {
    // redial depends on it, a library bump that drops it must fail here
    const actual = await vi.importActual<
      typeof import("home-assistant-js-websocket")
    >("home-assistant-js-websocket");
    const proto = actual.Connection.prototype as unknown as {
      _setSocket?: unknown;
    };
    expect(typeof proto._setSocket).toBe("function");
  });
});

describe("HomeAssistantClient connection recovery", () => {
  let listeners: Record<string, () => void>;
  let log: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createConnection).mockReset();
    vi.mocked(getConfig).mockReset();
    vi.mocked(getConfig).mockResolvedValue({ state: "RUNNING" } as never);
    listeners = {};
    log = {
      infoCtx: vi.fn(),
      warnCtx: vi.fn(),
      errorCtx: vi.fn(),
      debugCtx: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connect(connection: object) {
    vi.mocked(createConnection).mockResolvedValue({
      close: vi.fn(),
      closeRequested: false,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb;
      }),
      ...connection,
    } as never);
    const client = new HomeAssistantClient(
      { get: () => log } as unknown as LoggerService,
      options,
    );
    const init = client.construction;
    await vi.advanceTimersByTimeAsync(5_000);
    await init;
    return client;
  }

  it("reconnects a silent socket after two missed pongs, not after one", async () => {
    const reconnect = vi.fn();
    let answer = false;
    const sendMessagePromise = vi.fn(() =>
      answer ? Promise.resolve() : new Promise(() => {}),
    );
    const client = await connect({
      connected: true,
      reconnect,
      sendMessagePromise,
    });

    // miss, answer, miss: never two in a row
    await vi.advanceTimersByTimeAsync(40_000);
    answer = true;
    await vi.advanceTimersByTimeAsync(30_000);
    answer = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendMessagePromise).toHaveBeenCalledWith({ type: "ping" });
    expect(reconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith(true);
    await client.dispose();
  });

  it("dials again on the same connection after a reconnect-error", async () => {
    const socket = { haVersion: "2026.11" };
    const createSocket = vi.fn(async () => socket);
    const setSocket = vi.fn();
    const client = await connect({
      connected: false,
      options: { setupRetry: 0, createSocket },
      _setSocket: setSocket,
    });
    listeners.ready?.();

    listeners["reconnect-error"]();
    expect(client.haRunning).toBe(false);
    expect(log.errorCtx).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(setSocket).toHaveBeenCalledWith(socket);
  });

  it("keeps retrying a transient failure but stops on a second auth refusal", async () => {
    const createSocket = vi
      .fn()
      .mockRejectedValueOnce(ERR_CANNOT_CONNECT)
      .mockRejectedValueOnce(ERR_INVALID_AUTH);
    const setSocket = vi.fn();
    await connect({
      connected: false,
      options: { setupRetry: 0, createSocket },
      _setSocket: setSocket,
    });

    listeners["reconnect-error"]();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(setSocket).not.toHaveBeenCalled();
    expect(log.warnCtx).toHaveBeenCalledWith(
      "Unable to reconnect to Home Assistant, retrying...",
      expect.anything(),
    );
    expect(log.errorCtx).toHaveBeenCalledTimes(2);
  });
});

// #548: a non-admin token cannot fire events, the client learns the user once
// per connection so callers can skip what HA would refuse.
describe("HomeAssistantClient user lookup", () => {
  let listeners: Record<string, () => void>;
  let log: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createConnection).mockReset();
    vi.mocked(getConfig).mockResolvedValue({ state: "RUNNING" } as never);
    vi.mocked(getUser).mockReset();
    listeners = {};
    log = {
      info: vi.fn(),
      infoCtx: vi.fn(),
      warnCtx: vi.fn(),
      errorCtx: vi.fn(),
      debugCtx: vi.fn(),
    };
    vi.mocked(createConnection).mockResolvedValue({
      close: vi.fn(),
      sendMessagePromise: vi.fn(async () => ({ state: "RUNNING" })),
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb;
      }),
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connect(url = options.url) {
    const client = new HomeAssistantClient(
      { get: () => log } as unknown as LoggerService,
      { ...options, url },
    );
    const init = client.construction;
    await vi.advanceTimersByTimeAsync(5_000);
    await init;
    return client;
  }

  const notAdminLines = () =>
    log.info.mock.calls.filter(([m]) => String(m).includes("not an admin"));

  it("knows the user before the first command", async () => {
    vi.mocked(getUser).mockResolvedValue({
      name: "matter",
      is_admin: false,
    } as never);
    const client = await connect();
    expect(client.isAdmin).toBe(false);
    expect(notAdminLines()).toEqual([
      [
        'Home Assistant user "matter" is not an admin, hamh_action events and the vacuum segment lookup stay off',
      ],
    ]);
  });

  it("logs nothing for an admin", async () => {
    vi.mocked(getUser).mockResolvedValue({
      name: "admin",
      is_admin: true,
    } as never);
    const client = await connect();
    expect(client.isAdmin).toBe(true);
    expect(notAdminLines()).toHaveLength(0);
  });

  it("connects even when the lookup fails", async () => {
    vi.mocked(getUser).mockRejectedValue(new Error("unknown command"));
    const client = await connect();
    expect(client.isAdmin).toBeUndefined();
    expect(client.connection).toBeDefined();
    expect(log.debugCtx).toHaveBeenCalledWith(
      "Home Assistant user lookup failed",
      { reason: "unknown command" },
    );
  });

  it("asks again on reconnect and logs a non-admin only once", async () => {
    vi.mocked(getUser).mockResolvedValue({
      name: "matter",
      is_admin: false,
    } as never);
    const client = await connect();
    listeners.disconnected();
    listeners.ready();
    await vi.advanceTimersByTimeAsync(0);

    expect(getUser).toHaveBeenCalledTimes(2);
    expect(client.isAdmin).toBe(false);
    expect(notAdminLines()).toHaveLength(1);
  });

  it("connects after the timeout when the lookup never answers", async () => {
    vi.mocked(getUser).mockImplementation(() => new Promise(() => {}));
    const client = new HomeAssistantClient(
      { get: () => log } as unknown as LoggerService,
      options,
    );
    let done = false;
    client.construction.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(5_000 + options.messageTimeoutMs);

    expect(done).toBe(true);
    expect(client.isAdmin).toBeUndefined();
    expect(log.debugCtx).toHaveBeenCalledWith(
      "Home Assistant user lookup failed",
      expect.anything(),
    );
  });

  it("sees a drop while the first lookup is still pending", async () => {
    let answer!: (user: unknown) => void;
    vi.mocked(getUser).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
    );
    const client = new HomeAssistantClient(
      { get: () => log } as unknown as LoggerService,
      options,
    );
    const init = client.construction;
    await vi.advanceTimersByTimeAsync(5_000);

    listeners.disconnected();
    answer({ name: "admin", is_admin: true });
    await init;

    expect(client.haRunning).toBe(false);
    expect(client.isAdmin).toBe(true);
  });

  it("keeps the newer answer when two lookups resolve out of order", async () => {
    vi.mocked(getUser).mockResolvedValue({
      name: "admin",
      is_admin: true,
    } as never);
    const client = await connect();

    const answers: ((user: unknown) => void)[] = [];
    vi.mocked(getUser).mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }) as never,
    );
    listeners.ready();
    listeners.ready();
    answers[1]({ name: "matter", is_admin: false });
    await vi.advanceTimersByTimeAsync(0);
    answers[0]({ name: "admin", is_admin: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(client.isAdmin).toBe(false);
  });

  it("strips trailing slashes and spaces from the url", async () => {
    await connect("http://ha:8123// ");
    expect(createLongLivedTokenAuth).toHaveBeenLastCalledWith(
      "http://ha:8123",
      options.accessToken,
    );
  });
});
