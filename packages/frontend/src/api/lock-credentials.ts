import type { LockCredentialRequest } from "@home-assistant-matter-hub/common";
import { assertOk, parseJsonResponse } from "./fetch-utils.js";

/**
 * Sanitized credential returned from API (PIN is never exposed)
 */
export interface SanitizedCredential {
  entityId: string;
  name?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  hasPinCode: boolean;
}

export async function fetchLockCredentials(): Promise<{
  credentials: SanitizedCredential[];
}> {
  const response = await fetch("api/lock-credentials");
  await assertOk(response, "Failed to fetch lock credentials");
  return parseJsonResponse(response);
}

export async function updateLockCredential(
  entityId: string,
  config: LockCredentialRequest,
): Promise<SanitizedCredential> {
  const response = await fetch(
    `api/lock-credentials/${encodeURIComponent(entityId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    },
  );
  await assertOk(response, "Failed to update lock credential");
  return parseJsonResponse(response);
}

export async function toggleLockCredentialEnabled(
  entityId: string,
  enabled: boolean,
): Promise<SanitizedCredential> {
  const response = await fetch(
    `api/lock-credentials/${encodeURIComponent(entityId)}/enabled`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  await assertOk(response, "Failed to toggle credential");
  return parseJsonResponse(response);
}

export async function deleteLockCredential(entityId: string): Promise<void> {
  const response = await fetch(
    `api/lock-credentials/${encodeURIComponent(entityId)}`,
    { method: "DELETE" },
  );
  await assertOk(response, "Failed to delete lock credential");
}
