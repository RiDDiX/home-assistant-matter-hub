import { assertOk, parseJsonResponse } from "./fetch-utils.js";

const BASE_URL = "api/device-images";

export interface DeviceImageInfo {
  source: "custom" | "z2m" | "none";
  z2mUrl?: string;
}

export async function resolveDeviceImages(
  entityIds: string[],
): Promise<Record<string, DeviceImageInfo>> {
  const response = await fetch(`${BASE_URL}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entityIds }),
  });
  if (!response.ok) {
    return {};
  }
  return parseJsonResponse(response);
}

export async function uploadDeviceImage(
  entityId: string,
  file: File,
): Promise<void> {
  const formData = new FormData();
  formData.append("image", file);

  const response = await fetch(`${BASE_URL}/${encodeURIComponent(entityId)}`, {
    method: "POST",
    body: formData,
  });

  await assertOk(response, "Failed to upload image");
}

export async function deleteDeviceImage(entityId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/${encodeURIComponent(entityId)}`, {
    method: "DELETE",
  });
  await assertOk(response, "Failed to delete image");
}

export function getDeviceImageUrl(entityId: string): string {
  return `${BASE_URL}/${encodeURIComponent(entityId)}`;
}
