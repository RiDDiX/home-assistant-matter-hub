import { Logger } from "@matter/general";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginStorage } from "../../types.js";
import { CameraPlugin } from "./camera-plugin.js";
import {
  registerRequestor,
  sendAnswer,
  setRequestorInvokeForTests,
  unregisterRequestor,
} from "./requestor-client.js";

function makeStorage(stored?: unknown): PluginStorage {
  return {
    get: vi.fn(async () => stored),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    keys: vi.fn(async () => []),
  } as unknown as PluginStorage;
}

function createMockContext(
  overrides: Partial<PluginContext> = {},
): PluginContext {
  return {
    bridgeId: "b",
    log: Logger.get("test"),
    storage: makeStorage(),
    registerDevice: vi.fn(async () => {}),
    unregisterDevice: vi.fn(async () => {}),
    updateDeviceState: vi.fn(),
    registerDomainMapping: vi.fn(),
    ...overrides,
  };
}

describe("CameraPlugin", () => {
  it("uses the bridge's HA connection when config has none", async () => {
    const ctx = createMockContext({
      homeAssistant: { url: "http://ha:8123", accessToken: "tok" },
      storage: makeStorage({ cameras: "camera.front" }),
    });

    const plugin = new CameraPlugin();
    await plugin.onStart(ctx);

    expect(ctx.registerDevice).toHaveBeenCalledTimes(1);
    expect(ctx.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({ name: "camera.front" }),
    );
  });

  it("exposes nothing without a connection", async () => {
    const ctx = createMockContext({
      storage: makeStorage({ cameras: "camera.front" }),
    });

    const plugin = new CameraPlugin();
    await plugin.onStart(ctx);

    expect(ctx.registerDevice).not.toHaveBeenCalled();
  });

  it("leaves another bridge's requestor sessions alone through start and shutdown (#439 review)", async () => {
    setRequestorInvokeForTests(async () => true);
    // Registered by a different bridge's camera plugin, must survive this one.
    registerRequestor(97, {
      session: { isClosed: false } as never,
      requestorEndpoint: 1 as never,
      env: {} as never,
    });
    try {
      const ctx = createMockContext({
        storage: makeStorage({ cameras: "camera.front" }),
      });
      const plugin = new CameraPlugin();
      await plugin.onStart(ctx);
      await plugin.onShutdown();

      expect(await sendAnswer(97, "v=0")).toBe(true);
    } finally {
      unregisterRequestor(97);
      setRequestorInvokeForTests(undefined);
    }
  });
});
