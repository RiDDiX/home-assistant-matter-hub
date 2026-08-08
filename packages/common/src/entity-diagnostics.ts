import type { FailedEntity } from "./bridge-data.js";
import type {
  ControllerKey,
  ControllerWarning,
  ExposedDeviceType,
} from "./controller-compat.js";

export type EntityDiagnosticStatus = "ok" | "failed" | "limited";

export interface EntityControllerIssue {
  controller: ControllerKey;
  controllerLabel: string;
  note?: string;
}

export interface EntityDiagnostic {
  entityId: string;
  deviceTypeId?: number;
  status: EntityDiagnosticStatus;
  /** Why it failed to come up (status "failed"). */
  reason?: string;
  /** ISO time it failed (status "failed"). */
  failedAt?: string;
  /** Controllers that will not show this device (status "limited"). */
  unsupportedBy?: EntityControllerIssue[];
}

// Roll the per-bridge signals into one status per entity so the UI can answer
// "why is this device not working": it failed to come up, it is exposed but a
// commissioned controller will not show it, or it is fine.
export function buildEntityDiagnostics(
  exposed: ExposedDeviceType[],
  failed: FailedEntity[],
  warnings: ControllerWarning[],
): EntityDiagnostic[] {
  const result: EntityDiagnostic[] = failed.map((f) => ({
    entityId: f.entityId,
    status: "failed",
    reason: f.reason,
    failedAt: f.failedAt,
  }));

  const failedIds = new Set(failed.map((f) => f.entityId));

  const issuesByEntity = new Map<string, EntityControllerIssue[]>();
  for (const w of warnings) {
    const list = issuesByEntity.get(w.entityId) ?? [];
    list.push({
      controller: w.controller,
      controllerLabel: w.controllerLabel,
      note: w.note,
    });
    issuesByEntity.set(w.entityId, list);
  }

  for (const e of exposed) {
    if (failedIds.has(e.entityId)) continue;
    const issues = issuesByEntity.get(e.entityId);
    result.push({
      entityId: e.entityId,
      deviceTypeId: e.deviceTypeId,
      status: issues && issues.length > 0 ? "limited" : "ok",
      ...(issues && issues.length > 0 ? { unsupportedBy: issues } : {}),
    });
  }

  return result;
}
