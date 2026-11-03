import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders as renderInTheme } from "../../test/render.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";

// Mock the WebSocket context
vi.mock("../../contexts/WebSocketContext.tsx", () => ({
  useWebSocketStatus: () => ({ isConnected: true, closedOnce: false }),
}));

// the real routes module pulls in every page
vi.mock("../../routes.tsx", () => ({ navigation: { health: "/health" } }));

function healthResponse(status: number, body: object) {
  return { ok: status < 300, status, json: async () => body } as Response;
}

describe("StatusIndicator", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows 'Online' when health API returns healthy status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "healthy",
        version: "2.1.0",
        uptime: 3600,
        services: {
          bridges: { total: 1, running: 1, stopped: 0 },
          homeAssistant: { connected: true },
        },
      }),
    } as Response);

    renderInTheme(<StatusIndicator />);

    await waitFor(() => {
      expect(screen.getByText("Online")).toBeInTheDocument();
    });
  });

  it("shows 'Error' when health API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    renderInTheme(<StatusIndicator />);

    await waitFor(() => {
      expect(screen.getByText("Error")).toBeInTheDocument();
    });
  });

  it("shows 'Starting' when not all bridges are running", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "healthy",
        version: "2.1.0",
        uptime: 60,
        services: {
          bridges: { total: 2, running: 1, stopped: 1 },
          homeAssistant: { connected: true },
        },
      }),
    } as Response);

    renderInTheme(<StatusIndicator />);

    await waitFor(() => {
      expect(screen.getByText("Starting")).toBeInTheDocument();
    });
  });

  it("shows 'No Bridges' when no bridges are configured", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "healthy",
        version: "2.1.0",
        uptime: 3600,
        services: {
          bridges: { total: 0, running: 0, stopped: 0 },
          homeAssistant: { connected: true },
        },
      }),
    } as Response);

    renderInTheme(<StatusIndicator />);

    await waitFor(() => {
      expect(screen.getByText("No Bridges")).toBeInTheDocument();
    });
  });

  it("reads the 503 body when Home Assistant is disconnected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      healthResponse(503, {
        status: "unhealthy",
        version: "2.1.0",
        uptime: 60,
        services: {
          bridges: { total: 1, running: 1, stopped: 0 },
          homeAssistant: { connected: false },
        },
      }),
    );

    renderInTheme(<StatusIndicator />);

    await waitFor(() => {
      expect(screen.getByText("Unhealthy")).toBeInTheDocument();
    });
  });

  it("shows a warning, not unhealthy, when a bridge is stopped", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      healthResponse(200, {
        status: "degraded",
        version: "2.1.0",
        uptime: 60,
        services: {
          bridges: { total: 2, running: 1, stopped: 1 },
          homeAssistant: { connected: true },
        },
      }),
    );

    renderInTheme(<StatusIndicator />);

    const chip = await screen.findByText(/degraded/i);
    expect(chip.closest("a")).toHaveClass("MuiChip-colorWarning");
  });

  it("shows a neutral chip linking to health while loading", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));

    renderInTheme(<StatusIndicator />);

    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("Loading");
    expect(link).toHaveClass("MuiChip-colorDefault");
    expect(link).toHaveAttribute("href", "/health");
  });
});
