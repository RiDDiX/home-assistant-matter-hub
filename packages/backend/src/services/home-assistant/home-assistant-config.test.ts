import { describe, expect, it, vi } from "vitest";

vi.mock("home-assistant-js-websocket", () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from "home-assistant-js-websocket";
import type { HomeAssistantClient } from "./home-assistant-client.js";
import { HomeAssistantConfig } from "./home-assistant-config.js";

describe("HomeAssistantConfig", () => {
  it("follows a unit system change and a reconnect", async () => {
    const listeners: Record<string, () => void> = {};
    let onConfigUpdated: (() => void) | undefined;
    const connection = {
      addEventListener: (event: string, cb: () => void) => {
        listeners[event] = cb;
      },
      subscribeEvents: vi.fn(async (cb: () => void) => {
        onConfigUpdated = cb;
        return () => {};
      }),
    };
    vi.mocked(getConfig).mockResolvedValueOnce({
      unit_system: { temperature: "°C" },
    } as never);
    const config = new HomeAssistantConfig({
      connection,
    } as unknown as HomeAssistantClient);
    await config.construction;
    expect(config.unitSystem.temperature).toBe("°C");
    expect(connection.subscribeEvents).toHaveBeenCalledWith(
      expect.any(Function),
      "core_config_updated",
    );

    vi.mocked(getConfig).mockResolvedValueOnce({
      unit_system: { temperature: "°F" },
    } as never);
    onConfigUpdated?.();
    await vi.waitFor(() => expect(config.unitSystem.temperature).toBe("°F"));

    vi.mocked(getConfig).mockResolvedValueOnce({
      unit_system: { temperature: "°C" },
    } as never);
    listeners.ready();
    await vi.waitFor(() => expect(config.unitSystem.temperature).toBe("°C"));
  });
});
