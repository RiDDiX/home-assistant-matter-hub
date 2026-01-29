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

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to upload icon");
  }

  return response.json();
}

export async function deleteBridgeIcon(bridgeId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/${bridgeId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to delete icon");
  }
}

export async function checkBridgeIconExists(
  bridgeId: string,
): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/${bridgeId}`, {
    method: "HEAD",
  });
  return response.ok;
}

export function getBridgeIconUrl(bridgeId: string): string {
  return `${BASE_URL}/${bridgeId}`;
}
