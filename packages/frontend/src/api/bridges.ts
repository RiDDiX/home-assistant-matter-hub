import type {
  BridgeDataWithMetadata,
  CreateBridgeRequest,
  UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import { assertOk, parseJsonResponse } from "./fetch-utils.js";

export async function fetchBridges() {
  const res = await fetch(`api/matter/bridges?_s=${Date.now()}`);
  await assertOk(res, "Failed to fetch bridges");
  return parseJsonResponse<BridgeDataWithMetadata[]>(res);
}

export async function createBridge(req: CreateBridgeRequest) {
  const res = await fetch("api/matter/bridges", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req),
  });
  await assertOk(res, "Failed to create bridge");
  return parseJsonResponse<BridgeDataWithMetadata>(res);
}

export async function updateBridge(req: UpdateBridgeRequest) {
  const res = await fetch(`api/matter/bridges/${req.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req),
  });
  await assertOk(res, "Failed to update bridge");
  return parseJsonResponse<BridgeDataWithMetadata>(res);
}

export async function deleteBridge(bridgeId: string) {
  const res = await fetch(`api/matter/bridges/${bridgeId}`, {
    method: "DELETE",
  });
  await assertOk(res, "Failed to delete bridge");
}

export async function resetBridge(bridgeId: string) {
  const res = await fetch(
    `api/matter/bridges/${bridgeId}/actions/factory-reset`,
    {
      method: "POST",
    },
  );
  await assertOk(res, "Factory reset failed");
  return parseJsonResponse<BridgeDataWithMetadata>(res);
}

export interface OrphanCandidate {
  // Identity key for an "identity" row, mapping entityId for a "mapping" row.
  identityKey: string;
  lastEntityId: string;
  missingSince: string;
  hasMapping: boolean;
  kind: "identity" | "mapping";
}

export interface OrphanCleanupResult {
  identityKey: string;
  deleted: boolean;
  reason?: string;
}

export async function getOrphans(
  bridgeId: string,
): Promise<{ candidates: OrphanCandidate[] }> {
  const res = await fetch(
    `api/matter/bridges/${bridgeId}/orphans?_s=${Date.now()}`,
  );
  await assertOk(res, "Failed to load orphaned records");
  return parseJsonResponse(res);
}

export async function cleanupOrphans(
  bridgeId: string,
  identityKeys: string[],
): Promise<{ results: OrphanCleanupResult[] }> {
  const res = await fetch(
    `api/matter/bridges/${bridgeId}/actions/cleanup-orphans`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identityKeys }),
    },
  );
  await assertOk(res, "Cleanup failed");
  return parseJsonResponse(res);
}

export async function forceSyncBridge(
  bridgeId: string,
): Promise<{ syncedCount: number; bridge: BridgeDataWithMetadata }> {
  const res = await fetch(`api/matter/bridges/${bridgeId}/actions/force-sync`, {
    method: "POST",
  });
  await assertOk(res, "Force sync failed");
  return parseJsonResponse(res);
}

export async function openCommissioningWindow(
  bridgeId: string,
): Promise<{ success: boolean; bridge: BridgeDataWithMetadata }> {
  const res = await fetch(
    `api/matter/bridges/${bridgeId}/actions/open-commissioning-window`,
    { method: "POST" },
  );
  await assertOk(res, "Failed to open commissioning window");
  return parseJsonResponse(res);
}

export interface BridgePriorityUpdate {
  id: string;
  priority: number;
}

export async function updateBridgePriorities(
  updates: BridgePriorityUpdate[],
): Promise<void> {
  const res = await fetch("api/matter/bridges/priorities", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) {
    throw new Error("Failed to update priorities");
  }
}

export async function startAllBridges(): Promise<{
  success: boolean;
  count: number;
}> {
  const res = await fetch("api/matter/bridges/actions/start-all", {
    method: "POST",
  });
  await assertOk(res, "Failed to start all bridges");
  return parseJsonResponse(res);
}

export async function stopAllBridges(): Promise<{
  success: boolean;
  count: number;
}> {
  const res = await fetch("api/matter/bridges/actions/stop-all", {
    method: "POST",
  });
  await assertOk(res, "Failed to stop all bridges");
  return parseJsonResponse(res);
}

export async function restartAllBridges(): Promise<{
  success: boolean;
  count: number;
}> {
  const res = await fetch("api/matter/bridges/actions/restart-all", {
    method: "POST",
  });
  await assertOk(res, "Failed to restart all bridges");
  return parseJsonResponse(res);
}

export async function cloneBridge(
  bridgeId: string,
): Promise<BridgeDataWithMetadata> {
  const res = await fetch(`api/matter/bridges/${bridgeId}/clone`, {
    method: "POST",
  });
  await assertOk(res, "Clone failed");
  return parseJsonResponse<BridgeDataWithMetadata>(res);
}
