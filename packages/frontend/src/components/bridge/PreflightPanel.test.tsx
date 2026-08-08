import { ThemeProvider } from "@mui/material/styles";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appTheme } from "../../theme/theme.ts";
import { PreflightPanel } from "./PreflightPanel.tsx";
import type { NetworkDiagnosticResult } from "./preflight.ts";

function renderInTheme(ui: React.ReactElement) {
  return render(<ThemeProvider theme={appTheme}>{ui}</ThemeProvider>);
}

const payload: NetworkDiagnosticResult = {
  timestamp: "2026-07-27T00:00:00.000Z",
  interfaces: [],
  checks: [
    { name: "external_interface", status: "pass", message: "ok" },
    {
      name: "mdns_interface_binding",
      status: "fail",
      message: "Configured interface not found",
      detail: "Available interfaces: eth0.",
    },
  ],
  matterConfig: { boundInterface: "eth9", ipv4Enabled: true },
};

function stubFetch(data: NetworkDiagnosticResult) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => data,
    }),
  );
}

describe("PreflightPanel", () => {
  beforeEach(() => {
    stubFetch(payload);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders fail rows and reveals the remediation option", async () => {
    renderInTheme(<PreflightPanel port={5540} />);

    expect(
      await screen.findByText("Configured interface not found"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /how to fix/i }));
    expect(
      await screen.findByText("mdns_network_interface"),
    ).toBeInTheDocument();
  });

  it("shows the Alexa hint when the port is not 5540", async () => {
    renderInTheme(<PreflightPanel port={5541} />);
    expect(
      await screen.findByText(/Alexa only pairs on port/i),
    ).toBeInTheDocument();
  });

  it("hides the Alexa hint on port 5540", async () => {
    renderInTheme(<PreflightPanel port={5540} />);
    await waitFor(() =>
      expect(screen.getByText("Network preflight")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/Alexa only pairs on port/i),
    ).not.toBeInTheDocument();
  });
});
