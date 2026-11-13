import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as bridgesApi from "../../api/bridges.ts";
import { renderWithProviders } from "../../test/render.tsx";
import { DashboardPage } from "./DashboardPage.tsx";

vi.mock("../../api/bridges.ts");
vi.mock("../../routes.tsx", () => ({
  navigation: { bridge: (id: string) => `/bridges/${id}` },
}));

const health = {
  status: "healthy",
  version: "1.0.0",
  uptime: 60,
  services: {
    homeAssistant: { connected: true },
    bridges: { total: 1, running: 1, stopped: 0, failed: 0 },
  },
  bridgeDetails: [
    {
      id: "b1",
      name: "Living Room",
      status: "running",
      deviceCount: 3,
      fabricCount: 1,
      failedEntityCount: 0,
      priority: 100,
    },
  ],
};

function stubHealth(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "api/health/detailed"
        ? { ok: status === 200, status, json: async () => health }
        : { ok: false, status: 404, json: async () => ({}) },
    ),
  );
}

// Full page render, past 5 s under full suite load.
describe("DashboardPage", { timeout: 20_000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an error instead of the first-run onboarding when health fails", async () => {
    stubHealth(500);
    renderWithProviders(<DashboardPage />);

    expect(
      await screen.findByText("Unable to load health status"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Welcome to Home Assistant Matter Hub"),
    ).not.toBeInTheDocument();
  });

  it("asks before stopping every bridge", async () => {
    stubHealth(200);
    vi.mocked(bridgesApi.stopAllBridges).mockResolvedValue({
      success: true,
      count: 1,
    });
    renderWithProviders(<DashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop All" }));
    expect(bridgesApi.stopAllBridges).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Stop all bridges?");
    const stopButtons = screen.getAllByRole("button", { name: "Stop All" });
    fireEvent.click(stopButtons[stopButtons.length - 1]);

    await waitFor(() =>
      expect(bridgesApi.stopAllBridges).toHaveBeenCalledTimes(1),
    );
  });

  it("still renders when site storage is blocked", async () => {
    stubHealth(200);
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    try {
      renderWithProviders(<DashboardPage />);
      expect(
        await screen.findByRole("button", { name: "Stop All" }),
      ).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });
});
