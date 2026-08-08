import { assertOk, parseJsonResponse } from "./fetch-utils.js";

export interface SettingsAuthResponse {
  enabled: boolean;
  username?: string;
  source: "environment" | "storage" | "none";
}

export async function fetchAuthSettings(): Promise<SettingsAuthResponse> {
  const response = await fetch("api/settings/auth");
  await assertOk(response, "Failed to fetch auth settings");
  return parseJsonResponse(response);
}

export async function updateAuthSettings(
  username: string,
  password: string,
): Promise<SettingsAuthResponse> {
  const response = await fetch("api/settings/auth", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  await assertOk(response, "Failed to update auth settings");
  return parseJsonResponse(response);
}

export async function deleteAuthSettings(): Promise<SettingsAuthResponse> {
  const response = await fetch("api/settings/auth", {
    method: "DELETE",
  });
  await assertOk(response, "Failed to delete auth settings");
  return parseJsonResponse(response);
}

export interface RecoverySettingsResponse {
  autoRecoveryEnabled: boolean;
  recoveryIntervalMs: number;
}

export async function fetchRecoverySettings(): Promise<RecoverySettingsResponse> {
  const response = await fetch("api/settings/recovery");
  await assertOk(response, "Failed to fetch recovery settings");
  return parseJsonResponse(response);
}

export async function updateRecoverySettings(
  settings: Partial<RecoverySettingsResponse>,
): Promise<RecoverySettingsResponse> {
  const response = await fetch("api/settings/recovery", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  await assertOk(response, "Failed to update recovery settings");
  return parseJsonResponse(response);
}
