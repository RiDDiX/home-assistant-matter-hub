import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as backupApi from "../../api/backup.js";
import { renderWithProviders } from "../../test/render.tsx";
import { BackupRestore } from "./BackupRestore.tsx";

vi.mock("../../api/backup.js");

describe("BackupRestore retention field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backupApi.fetchBackupSnapshots).mockResolvedValue([]);
    vi.mocked(backupApi.fetchBackupSettings).mockResolvedValue({
      autoBackup: true,
      backupRetentionCount: 5,
    });
    vi.mocked(backupApi.updateBackupSettings).mockImplementation(
      async (changes) => ({
        autoBackup: true,
        backupRetentionCount: changes.backupRetentionCount ?? 5,
      }),
    );
  });

  it("saves once on blur, not on every keystroke", async () => {
    renderWithProviders(<BackupRestore />);
    const field = await screen.findByLabelText("Keep Backups");

    fireEvent.change(field, { target: { value: "1" } });
    fireEvent.change(field, { target: { value: "10" } });
    expect(backupApi.updateBackupSettings).not.toHaveBeenCalled();

    fireEvent.blur(field);
    expect(backupApi.updateBackupSettings).toHaveBeenCalledTimes(1);
    expect(backupApi.updateBackupSettings).toHaveBeenCalledWith({
      backupRetentionCount: 10,
    });
  });

  it("can be cleared while typing and snaps back when left invalid", async () => {
    renderWithProviders(<BackupRestore />);
    const field = await screen.findByLabelText("Keep Backups");

    fireEvent.change(field, { target: { value: "" } });
    expect(field).toHaveValue(null);

    fireEvent.blur(field);
    expect(backupApi.updateBackupSettings).not.toHaveBeenCalled();
    expect(await screen.findByDisplayValue("5")).toBe(field);
  });
});
