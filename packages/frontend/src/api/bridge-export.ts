import type {
  BridgeExportData,
  BridgeImportPreview,
  BridgeImportRequest,
  BridgeImportResult,
} from "@home-assistant-matter-hub/common";
import { assertOk, parseJsonResponse } from "./fetch-utils.js";

export async function exportAllBridges(): Promise<void> {
  const response = await fetch("api/bridges/export");
  await assertOk(response, "Failed to export bridges");
  const blob = await response.blob();
  const contentDisposition = response.headers.get("Content-Disposition");
  const filename =
    contentDisposition?.match(/filename="(.+)"/)?.[1] ||
    `hamh-bridges-${new Date().toISOString().split("T")[0]}.json`;
  downloadBlob(blob, filename);
}

export async function exportBridge(bridgeId: string): Promise<void> {
  const response = await fetch(`api/bridges/export/${bridgeId}`);
  await assertOk(response, "Failed to export bridge");
  const blob = await response.blob();
  const contentDisposition = response.headers.get("Content-Disposition");
  const filename =
    contentDisposition?.match(/filename="(.+)"/)?.[1] ||
    `hamh-bridge-${bridgeId}.json`;
  downloadBlob(blob, filename);
}

export async function previewImport(
  data: BridgeExportData,
): Promise<BridgeImportPreview> {
  const response = await fetch("api/bridges/import/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await assertOk(response, "Failed to preview import");
  return parseJsonResponse(response);
}

export async function importBridges(
  data: BridgeExportData,
  options: BridgeImportRequest,
): Promise<BridgeImportResult> {
  const response = await fetch("api/bridges/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, options }),
  });
  await assertOk(response, "Failed to import bridges");
  return parseJsonResponse(response);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
