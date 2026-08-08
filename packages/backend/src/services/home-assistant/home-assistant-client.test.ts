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
    const connection = { close: vi.fn() };
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
