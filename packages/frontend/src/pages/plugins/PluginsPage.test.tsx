import {
  type BridgeDataWithMetadata,
  BridgeStatus,
} from "@home-assistant-matter-hub/common";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBridgesFromWebSocket } from "../../state/bridges/bridge-actions.ts";
import { store } from "../../state/store.ts";
import { renderWithProviders } from "../../test/render.tsx";
import { PluginsPage, pluginsEmptyState } from "./PluginsPage.tsx";

// #432 follow-up: GET /api/plugins skips server mode bridges, so a user whose
// bridges are all server mode saw "No plugins installed" and tried to install
// the built-in camera from npm.

function bridge(
  id: string,
  serverMode: boolean,
  status = BridgeStatus.Running,
): BridgeDataWithMetadata {
  return {
    id,
    name: `Bridge ${id}`,
    port: 5540,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: { serverMode },
    status,
    deviceCount: 0,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    basicInformation: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any;
}

describe("pluginsEmptyState", () => {
  const noPlugins = { bridgePlugins: [], installed: [] };

  it("keeps the generic hint while bridges are loading or failed to load", () => {
    // Never a blank page: a load failure leaves bridges undefined for good.
    expect(pluginsEmptyState({ ...noPlugins, bridges: undefined })).toBe(
      "none-installed",
    );
  });

  it("stays quiet as soon as anything is installed or loaded", () => {
    expect(
      pluginsEmptyState({
        bridges: [bridge("a", false)],
        bridgePlugins: [],
        // biome-ignore lint/suspicious/noExplicitAny: only the length matters
        installed: [{} as any],
      }),
    ).toBeUndefined();
    expect(
      pluginsEmptyState({
        bridges: [bridge("a", false)],
        bridgePlugins: [
          {
            bridgeId: "a",
            bridgeName: "a",
            // biome-ignore lint/suspicious/noExplicitAny: only the length matters
            plugins: [{} as any],
          },
        ],
        installed: [],
      }),
    ).toBeUndefined();
  });

  it("reports no bridges when none are configured", () => {
    expect(pluginsEmptyState({ ...noPlugins, bridges: [] })).toBe("no-bridges");
  });

  it("reports server mode when every bridge is server mode", () => {
    expect(
      pluginsEmptyState({
        ...noPlugins,
        bridges: [bridge("a", true), bridge("b", true)],
      }),
    ).toBe("all-server-mode");
  });

  it("reports a stopped bridge when no plugin-capable bridge runs", () => {
    expect(
      pluginsEmptyState({
        ...noPlugins,
        bridges: [bridge("a", true), bridge("b", false, BridgeStatus.Stopped)],
      }),
    ).toBe("bridge-not-running");
  });

  it("falls back to the install hint on a running plugin-capable bridge", () => {
    expect(
      pluginsEmptyState({
        ...noPlugins,
        bridges: [bridge("a", true), bridge("b", false)],
      }),
    ).toBe("none-installed");
  });
});

describe("PluginsPage empty state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [],
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.dispatch(setBridgesFromWebSocket([]));
  });

  it("explains server mode instead of offering an npm install", async () => {
    store.dispatch(setBridgesFromWebSocket([bridge("sm", true)]));

    renderWithProviders(<PluginsPage />);

    expect(
      await screen.findByText(/Server mode bridges host none/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No plugins installed/i)).not.toBeInTheDocument();
    // Every bridge is accounted for in the list.
    expect(screen.getByText("Bridge sm")).toBeInTheDocument();
    expect(
      screen.getByText(/Server mode bridge, hosts no plugins/i),
    ).toBeInTheDocument();
  });
});
