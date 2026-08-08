import { ThemeProvider } from "@mui/material/styles";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appTheme } from "../../theme/theme.ts";
import { StatusIndicator } from "./StatusIndicator.tsx";

// Mock the WebSocket context
vi.mock("../../contexts/WebSocketContext.tsx", () => ({
  useWebSocketStatus: () => ({ isConnected: true }),
}));

function renderInTheme(ui: React.ReactElement) {
  return render(<ThemeProvider theme={appTheme}>{ui}</ThemeProvider>);
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
});
