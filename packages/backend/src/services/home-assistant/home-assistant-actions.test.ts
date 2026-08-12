import { describe, expect, it, vi } from "vitest";
import type { LoggerService } from "../../core/app/logger.js";
import { HomeAssistantActions } from "./home-assistant-actions.js";
import type { HomeAssistantClient } from "./home-assistant-client.js";

// #446: a command must not report success when the call cannot reach HA, and
// one broken entity must not take every other device down with it.

function fakeLogger(): LoggerService {
  return {
    get: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  } as unknown as LoggerService;
}

function makeActions(sendMessagePromise: () => Promise<unknown>) {
  const client = {
    haRunning: true,
    messageTimeoutMs: 50,
    connection: { sendMessagePromise },
  } as unknown as HomeAssistantClient;
  const actions = new HomeAssistantActions(fakeLogger(), client, {
    retryAttempts: 1,
    retryBaseDelayMs: 1,
    circuitBreakerResetMs: 10_000,
  });
  return { actions, client };
}

describe("HomeAssistantActions availability (#446)", () => {
  it("follows the transport, not the app-wide breaker", () => {
    const { actions, client } = makeActions(async () => ({}));
    expect(actions.available).toBe(true);

    (client as unknown as { haRunning: boolean }).haRunning = false;
    expect(actions.available).toBe(false);
  });

  it("blocks only the entity that keeps failing", async () => {
    const { actions } = makeActions(async () => {
      throw new Error("no such service");
    });

    // Drive the real chain: call -> debounce -> processAction -> bookkeeping.
    for (let i = 0; i < 3; i++) {
      actions.call({ action: "light.turn_on" }, "light.broken");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await vi.waitFor(() =>
      expect(actions.isTargetBlocked("light.broken")).toBe(true),
    );

    // A healthy entity on the same connection is untouched, and the app-wide
    // availability signal stays up.
    expect(actions.isTargetBlocked("light.fine")).toBe(false);
    expect(actions.available).toBe(true);
  });

  it("keys the failure on the entity that issued the action, not its target", async () => {
    const { actions } = makeActions(async () => {
      throw new Error("no such service");
    });

    // An identify press targets a sibling button, but the failing device is
    // the endpoint that issued it.
    for (let i = 0; i < 3; i++) {
      actions.call(
        { action: "button.press", target: "button.lamp_identify" },
        "light.lamp",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    await vi.waitFor(() =>
      expect(actions.isTargetBlocked("light.lamp")).toBe(true),
    );
  });

  it("clears the block after a call succeeds", async () => {
    let fail = true;
    const { actions } = makeActions(async () => {
      if (fail) throw new Error("no such service");
      return {};
    });

    for (let i = 0; i < 3; i++) {
      actions.call({ action: "light.turn_on" }, "light.flaky");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await vi.waitFor(() =>
      expect(actions.isTargetBlocked("light.flaky")).toBe(true),
    );

    fail = false;
    actions.call({ action: "light.turn_on" }, "light.flaky");
    await vi.waitFor(() =>
      expect(actions.isTargetBlocked("light.flaky")).toBe(false),
    );
  });
});
