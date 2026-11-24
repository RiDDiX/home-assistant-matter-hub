import { describe, expect, it, vi } from "vitest";

import type { HomeAssistantClient } from "./home-assistant-client.js";
import { HomeAssistantConfig } from "./home-assistant-config.js";

describe("HomeAssistantConfig", () => {
  it("follows a unit system change and a reconnect", async () => {
    const listeners: Record<string, () => void> = {};
    let onConfigUpdated: (() => void) | undefined;
    const sendMessagePromise = vi.fn();
    const connection = {
      sendMessagePromise,
      addEventListener: (event: string, cb: () => void) => {
        listeners[event] = cb;
      },
      subscribeEvents: vi.fn((cb: () => void) => {
        onConfigUpdated = cb;
        return new Promise(() => {});
      }),
    };
    const config = new HomeAssistantConfig({
      connection,
      initialConfig: { unit_system: { temperature: "°C" } },
    } as unknown as HomeAssistantClient);
    await config.construction;
    expect(config.unitSystem.temperature).toBe("°C");
    expect(sendMessagePromise).not.toHaveBeenCalled();
    expect(connection.subscribeEvents).toHaveBeenCalledWith(
      expect.any(Function),
      "core_config_updated",
    );

    sendMessagePromise.mockResolvedValueOnce({
      unit_system: { temperature: "°F" },
    } as never);
    onConfigUpdated?.();
    await vi.waitFor(() => expect(config.unitSystem.temperature).toBe("°F"));

    sendMessagePromise.mockResolvedValueOnce({
      unit_system: { temperature: "°C" },
    } as never);
    listeners.ready();
    await vi.waitFor(() => expect(config.unitSystem.temperature).toBe("°C"));
  });
});
