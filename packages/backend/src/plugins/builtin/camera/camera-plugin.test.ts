import { Logger } from "@matter/general";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginStorage } from "../../types.js";
import { CameraPlugin } from "./camera-plugin.js";

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
});
