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

// Mirror of the backend SubscriptionSummary, only the fields the scope line
// needs. Kept local like the other health API shapes the frontend re-declares.
export interface SubscriptionScopeInput {
  scope: "wildcard" | "endpoint-specific" | "unknown";
  endpointIds: number[];
}

export interface SessionInput {
  fabricIndex: number | null;
  subscriptionCount: number;
  subscriptions?: SubscriptionScopeInput[];
  lastActiveMsAgo?: number | null;
  isPeerActive?: boolean;
}

// What the fabric's subscriptions watch, rolled up across its sessions.
export type SubscriptionScope =
  | { kind: "wildcard" }
  | { kind: "endpoint-specific"; endpointIds: number[] }
  | { kind: "unknown" };

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
  subscriptionScope: SubscriptionScope | null;
}

// Roll a fabric's subscription summaries into a single scope. A wildcard on
// any subscription covers the whole node, so it wins; an unknown next; only
// then the union of concrete endpoints. Returns null when nothing to describe.
export function describeSubscriptionScope(
  summaries: SubscriptionScopeInput[],
): SubscriptionScope | null {
  if (summaries.length === 0) {
    return null;
  }
  if (summaries.some((s) => s.scope === "wildcard")) {
    return { kind: "wildcard" };
  }
  if (summaries.some((s) => s.scope === "unknown")) {
    return { kind: "unknown" };
  }
  const endpointIds = [
    ...new Set(summaries.flatMap((s) => s.endpointIds)),
  ].sort((a, b) => a - b);
  if (endpointIds.length === 0) {
    return null;
  }
  return { kind: "endpoint-specific", endpointIds };
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
    const subscriptionScope = describeSubscriptionScope(
      own.flatMap((s) => s.subscriptions ?? []),
    );
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
      subscriptionScope,
    };
  });
}
