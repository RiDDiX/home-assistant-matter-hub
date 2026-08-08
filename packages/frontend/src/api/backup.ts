import { assertOk, parseJsonResponse } from "./fetch-utils.js";

export interface BackupMetadata {
  filename: string;
  version: string;
  createdAt: string;
  sizeBytes: number;
  auto: boolean;
}

export interface BackupSettings {
  autoBackup: boolean;
  backupRetentionCount: number;
}

export async function fetchBackupSnapshots(): Promise<BackupMetadata[]> {
  const res = await fetch("api/backup/snapshots");
  await assertOk(res, "Failed to fetch backups");
  return parseJsonResponse(res);
}

export async function createBackupSnapshot(): Promise<BackupMetadata> {
  const res = await fetch("api/backup/snapshots/create", { method: "POST" });
  await assertOk(res, "Failed to create backup");
  return parseJsonResponse(res);
}

export async function downloadBackupSnapshot(filename: string): Promise<void> {
  const res = await fetch(
    `api/backup/snapshots/${encodeURIComponent(filename)}/download`,
  );
  if (!res.ok) {
    throw new Error("Failed to download backup");
  }
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

export async function restoreBackupSnapshot(
  filename: string,
  options?: {
    overwriteExisting?: boolean;
    includeMappings?: boolean;
    restoreIdentity?: boolean;
  },
): Promise<{
  bridgesRestored: number;
  bridgesSkipped: number;
  mappingsRestored: number;
  identitiesRestored: number;
  errors: Array<{ bridgeId: string; error: string }>;
  restartRequired: boolean;
}> {
  const res = await fetch(
    `api/backup/snapshots/${encodeURIComponent(filename)}/restore`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overwriteExisting: true,
        includeMappings: true,
        restoreIdentity: true,
        ...options,
      }),
    },
  );
  await assertOk(res, "Failed to restore backup");
  return parseJsonResponse(res);
}

export async function deleteBackupSnapshot(filename: string): Promise<void> {
  const res = await fetch(
    `api/backup/snapshots/${encodeURIComponent(filename)}`,
    { method: "DELETE" },
  );
  await assertOk(res, "Failed to delete backup");
}

export async function fetchBackupSettings(): Promise<BackupSettings> {
  const res = await fetch("api/backup/settings");
  await assertOk(res, "Failed to fetch backup settings");
  return parseJsonResponse(res);
}

export async function updateBackupSettings(
  settings: Partial<BackupSettings>,
): Promise<BackupSettings> {
  const res = await fetch("api/backup/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  await assertOk(res, "Failed to update backup settings");
  return parseJsonResponse(res);
}
