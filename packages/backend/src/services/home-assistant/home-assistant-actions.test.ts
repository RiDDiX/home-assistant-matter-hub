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

function makeActions(
  sendMessagePromise: (message: {
    type: string;
    [key: string]: unknown;
  }) => Promise<unknown>,
) {
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

describe("HomeAssistantActions debounce", () => {
  it("keeps explicit commands separate while coalescing adjustments", async () => {
    const serviceData: unknown[] = [];
    const sendMessagePromise = async (message: {
      type: string;
      [key: string]: unknown;
    }) => {
      if (message.type === "call_service") {
        serviceData.push(message.service_data);
      }
      return {};
    };
    const { actions } = makeActions(sendMessagePromise);

    actions.call(
      { action: "light.turn_on", data: { brightness: 100 } },
      "light.lamp",
    );
    actions.call({ action: "light.turn_on" }, "light.lamp");
    actions.call(
      { action: "light.turn_on", data: { brightness: 200 } },
      "light.lamp",
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(serviceData).toEqual([{ brightness: 200 }, {}]);
  });
});

// #491: Alexa sends On, then the level 37ms later, and the light flashed to
// its old brightness first.
describe("HomeAssistantActions on-then-level (#491)", () => {
  function recorder() {
    const sent: { service: string; data: unknown }[] = [];
    const { actions } = makeActions(async (message) => {
      if (message.type === "call_service") {
        sent.push({
          service: `${message.domain}.${message.service}`,
          data: message.service_data,
        });
      }
      return {};
    });
    return { actions, sent };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("sends one turn_on with the brightness, not a bare one before it", async () => {
    const { actions, sent } = recorder();

    actions.call({ action: "light.turn_on" }, "light.buro_stehlampe");
    await wait(37);
    actions.call(
      { action: "light.turn_on", data: { brightness: 25 } },
      "light.buro_stehlampe",
    );
    await wait(200);

    expect(sent).toEqual([
      { service: "light.turn_on", data: { brightness: 25 } },
    ]);
  });

  it("covers colour too, the same pair with a hue instead of a level", async () => {
    const { actions, sent } = recorder();

    actions.call({ action: "light.turn_on" }, "light.lamp");
    await wait(20);
    actions.call(
      { action: "light.turn_on", data: { hs_color: [0, 100] } },
      "light.lamp",
    );
    await wait(200);

    expect(sent).toEqual([
      { service: "light.turn_on", data: { hs_color: [0, 100] } },
    ]);
  });

  it("still sends a bare On that has nothing after it", async () => {
    const { actions, sent } = recorder();

    actions.call({ action: "light.turn_on" }, "light.lamp");
    await wait(200);

    expect(sent).toEqual([{ service: "light.turn_on", data: {} }]);
  });

  // #453: Flic sends level, On, level, and some lights need that bare On
  it("keeps an explicit On that follows a level change (#453)", async () => {
    const { actions, sent } = recorder();

    actions.call(
      { action: "light.turn_on", data: { brightness: 100 } },
      "light.lamp",
    );
    await wait(10);
    actions.call({ action: "light.turn_on" }, "light.lamp");
    await wait(10);
    actions.call(
      { action: "light.turn_on", data: { brightness: 200 } },
      "light.lamp",
    );
    await wait(200);

    expect(sent).toContainEqual({ service: "light.turn_on", data: {} });
    expect(sent).toContainEqual({
      service: "light.turn_on",
      data: { brightness: 200 },
    });
  });

  it("keeps an explicit On after an earlier standalone On", async () => {
    const { actions, sent } = recorder();

    actions.call({ action: "light.turn_on" }, "light.lamp");
    await wait(200);
    actions.call(
      { action: "light.turn_on", data: { brightness: 100 } },
      "light.lamp",
    );
    await wait(10);
    actions.call({ action: "light.turn_on" }, "light.lamp");
    await wait(10);
    actions.call(
      { action: "light.turn_on", data: { brightness: 150 } },
      "light.lamp",
    );
    await wait(200);

    expect(sent.filter((c) => JSON.stringify(c.data) === "{}")).toHaveLength(2);
  });

  it("leaves other lights alone", async () => {
    const { actions, sent } = recorder();

    actions.call({ action: "light.turn_on" }, "light.a");
    await wait(10);
    actions.call(
      { action: "light.turn_on", data: { brightness: 25 } },
      "light.b",
    );
    await wait(200);

    expect(sent).toContainEqual({ service: "light.turn_on", data: {} });
    expect(sent).toContainEqual({
      service: "light.turn_on",
      data: { brightness: 25 },
    });
  });

  // script.turn_on with variables starts a second run
  it("does not touch any action but light.turn_on", async () => {
    for (const [action, target] of [
      ["light.toggle", "light.lamp"],
      ["script.turn_on", "script.scene"],
      ["fan.turn_on", "fan.ceiling"],
    ]) {
      const { actions, sent } = recorder();

      actions.call({ action }, target);
      await wait(10);
      actions.call({ action, data: { brightness: 25 } }, target);
      await wait(200);

      expect(sent, action).toHaveLength(2);
    }
  });

  // a slower Flic
  it("keeps an explicit On after a level change that already went out", async () => {
    const { actions, sent } = recorder();

    actions.call(
      { action: "light.turn_on", data: { brightness: 100 } },
      "light.lamp",
    );
    await wait(120);
    actions.call({ action: "light.turn_on" }, "light.lamp");
    await wait(30);
    actions.call(
      { action: "light.turn_on", data: { brightness: 200 } },
      "light.lamp",
    );
    await wait(200);

    expect(sent).toContainEqual({ service: "light.turn_on", data: {} });
  });

  it("never drops an explicit On that shares a buffer", async () => {
    const { actions, sent } = recorder();

    actions.call(
      { action: "light.turn_on", data: { brightness: 100 } },
      "light.lamp",
    );
    await wait(90);
    actions.call({ action: "light.turn_on" }, "light.lamp");
    await wait(20);
    actions.call({ action: "light.turn_on" }, "light.lamp");
    await wait(30);
    actions.call(
      { action: "light.turn_on", data: { brightness: 200 } },
      "light.lamp",
    );
    await wait(200);

    expect(sent).toContainEqual({ service: "light.turn_on", data: {} });
  });

  it("treats an On long after the last level change as a new pair", async () => {
    vi.useFakeTimers();
    try {
      const { actions, sent } = recorder();

      actions.call(
        { action: "light.turn_on", data: { brightness: 254 } },
        "light.lamp",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      actions.call({ action: "light.turn_on" }, "light.lamp");
      await vi.advanceTimersByTimeAsync(37);
      actions.call(
        { action: "light.turn_on", data: { brightness: 25 } },
        "light.lamp",
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(sent).toEqual([
        { service: "light.turn_on", data: { brightness: 254 } },
        { service: "light.turn_on", data: { brightness: 25 } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // the first On is inside the window
  it("keeps an explicit On when a later On lands in its buffer past the window", async () => {
    vi.useFakeTimers();
    try {
      const { actions, sent } = recorder();

      actions.call(
        { action: "light.turn_on", data: { brightness: 100 } },
        "light.lamp",
      );
      await vi.advanceTimersByTimeAsync(1_950);
      actions.call({ action: "light.turn_on" }, "light.lamp");
      await vi.advanceTimersByTimeAsync(60);
      actions.call({ action: "light.turn_on" }, "light.lamp");
      await vi.advanceTimersByTimeAsync(30);
      actions.call(
        { action: "light.turn_on", data: { brightness: 200 } },
        "light.lamp",
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(sent).toContainEqual({ service: "light.turn_on", data: {} });
    } finally {
      vi.useRealTimers();
    }
  });
});
