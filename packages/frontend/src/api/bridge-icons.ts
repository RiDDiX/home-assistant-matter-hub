import { assertOk, parseJsonResponse } from "./fetch-utils.js";

const BASE_URL = "api/bridge-icons";

export async function uploadBridgeIcon(
  bridgeId: string,
  file: File,
): Promise<{ success: boolean; iconUrl: string }> {
  const formData = new FormData();
  formData.append("icon", file);

  const response = await fetch(`${BASE_URL}/${bridgeId}`, {
    method: "POST",
    body: formData,
  });
  await assertOk(response, "Failed to upload icon");
  return parseJsonResponse(response);
}

export async function deleteBridgeIcon(bridgeId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/${bridgeId}`, {
    method: "DELETE",
  });
  await assertOk(response, "Failed to delete icon");
}

export async function checkBridgeIconExists(
  bridgeId: string,
): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/${bridgeId}/exists`);
  if (!response.ok) {
    return false;
  }
  const { exists } = await parseJsonResponse<{ exists: boolean }>(response);
  return exists;
}

export function getBridgeIconUrl(bridgeId: string): string {
  return `${BASE_URL}/${bridgeId}`;
}
