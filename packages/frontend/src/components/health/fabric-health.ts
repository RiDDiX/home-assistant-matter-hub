import {
  type ControllerKey,
  classifyController,
} from "@home-assistant-matter-hub/common";

// Subscriptions exist but no peer traffic for this long: a stale link. The
// bridge keepalive only lands every ~48-56s (60s max interval), so this must
// clear two cycles to avoid flagging a healthy but quiet controller.
export const FABRIC_STALE_MS = 120_000;

export interface FabricInput {
  fabricIndex: number;
  rootVendorId: number;
  label: string;
}

export interface SessionInput {
  fabricIndex: number | null;
  subscriptionCount: number;
  lastActiveMsAgo?: number | null;
  isPeerActive?: boolean;
}

export interface FabricHealth {
  fabricIndex: number;
  rootVendorId: number;
  label: string;
  ecosystem?: ControllerKey;
  connected: boolean;
  stale: boolean;
  subscriptions: number;
  sessions: number;
  lastActiveMsAgo: number | null;
}

// One health row per fabric, tagged with the controller ecosystem.
export function summarizeFabricHealth(
  fabrics: FabricInput[],
  sessions: SessionInput[],
): FabricHealth[] {
  return fabrics.map((fabric) => {
    const own = sessions.filter((s) => s.fabricIndex === fabric.fabricIndex);
    const subscriptions = own.reduce((n, s) => n + s.subscriptionCount, 0);
    const actives = own
      .map((s) => s.lastActiveMsAgo)
      .filter((v): v is number => v != null);
    const lastActiveMsAgo = actives.length ? Math.min(...actives) : null;
    const stale =
      subscriptions > 0 &&
      lastActiveMsAgo != null &&
      lastActiveMsAgo > FABRIC_STALE_MS;
    return {
      fabricIndex: fabric.fabricIndex,
      rootVendorId: fabric.rootVendorId,
      label: fabric.label,
      ecosystem: classifyController(fabric.rootVendorId),
      connected: own.length > 0,
      stale,
      subscriptions,
      sessions: own.length,
      lastActiveMsAgo,
    };
  });
}
