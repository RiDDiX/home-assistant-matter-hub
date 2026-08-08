import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsApi from "../../api/settings.ts";
import { renderWithProviders } from "../../test/render.tsx";
import { RecoverySettingsCard } from "./RecoverySettingsCard.tsx";

vi.mock("../../api/settings.ts");

describe("RecoverySettingsCard", () => {
  beforeEach(() => {
    vi.mocked(settingsApi.fetchRecoverySettings).mockResolvedValue({
      autoRecoveryEnabled: true,
      recoveryIntervalMs: 60000,
    });
    vi.mocked(settingsApi.updateRecoverySettings).mockResolvedValue({
      autoRecoveryEnabled: true,
      recoveryIntervalMs: 60000,
    });
  });

  it("shows the interval in seconds and saves it back in milliseconds", async () => {
    renderWithProviders(<RecoverySettingsCard />);

    expect(await screen.findByDisplayValue("60")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(settingsApi.updateRecoverySettings).toHaveBeenCalledWith({
        autoRecoveryEnabled: true,
        recoveryIntervalMs: 60000,
      }),
    );
  });
});
