// Summarize a controller's active subscriptions into a scope descriptor the
// health view can render. Pure and defensive: reads matter.js internal
// ServerSubscription fields by duck typing, so an unreadable request is
// classified "unknown" instead of guessed.

export interface SubscriptionSummary {
  // subscriptionId, or null when it could not be read.
  id: number | null;
  attributePaths: number;
  eventPaths: number;
  // wildcard: at least one path omits the endpointId, so it covers the whole
  // node. endpoint-specific: every path names a concrete endpoint. unknown:
  // the request could not be read in the shape we expect.
  scope: "wildcard" | "endpoint-specific" | "unknown";
  // Concrete endpoint ids named across all paths, deduped and sorted.
  endpointIds: number[];
}

interface PathLike {
  endpointId?: unknown;
}

function readPaths(value: unknown): PathLike[] | null {
  return Array.isArray(value) ? (value as PathLike[]) : null;
}

function unknownSummary(id: number | null): SubscriptionSummary {
  return {
    id,
    attributePaths: 0,
    eventPaths: 0,
    scope: "unknown",
    endpointIds: [],
  };
}

export function summarizeSubscription(sub: unknown): SubscriptionSummary {
  let id: number | null = null;
  let request: unknown;
  try {
    const s = sub as { subscriptionId?: unknown; request?: unknown };
    if (typeof s.subscriptionId === "number") {
      id = s.subscriptionId;
    }
    request = s.request;
  } catch {
    return unknownSummary(id);
  }

  if (request == null || typeof request !== "object") {
    return unknownSummary(id);
  }

  const req = request as {
    attributeRequests?: unknown;
    eventRequests?: unknown;
  };
  const attrPaths = readPaths(req.attributeRequests);
  const eventPaths = readPaths(req.eventRequests);

  // Present but not in the shape we expect: do not guess the scope.
  if (attrPaths === null && eventPaths === null) {
    return unknownSummary(id);
  }

  const all = [...(attrPaths ?? []), ...(eventPaths ?? [])];
  let wildcard = false;
  const endpointIds = new Set<number>();
  for (const path of all) {
    const ep = path?.endpointId;
    if (ep == null) {
      // An omitted endpointId means the path spans every endpoint (#365 class).
      wildcard = true;
    } else if (typeof ep === "number" || typeof ep === "bigint") {
      endpointIds.add(Number(ep));
    }
  }

  return {
    id,
    attributePaths: attrPaths?.length ?? 0,
    eventPaths: eventPaths?.length ?? 0,
    scope: wildcard ? "wildcard" : "endpoint-specific",
    endpointIds: [...endpointIds].sort((a, b) => a - b),
  };
}

export function summarizeSubscriptions(
  subscriptions: Iterable<unknown>,
): SubscriptionSummary[] {
  const out: SubscriptionSummary[] = [];
  try {
    for (const sub of subscriptions) {
      out.push(summarizeSubscription(sub));
    }
  } catch {
    // subscriptions was not iterable or iteration threw
  }
  return out;
}
