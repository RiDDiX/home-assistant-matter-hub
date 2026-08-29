import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import {
  DestroyedDependencyError,
  TransactionDestroyedError,
} from "@matter/general";
import type { Endpoint } from "@matter/main";
import { HomeAssistantEntityBehavior } from "../behaviors/home-assistant-entity-behavior.js";

// One state write per endpoint at a time. Two overlapping setStateOf
// transactions on the same endpoint cannot take the lock synchronously, and
// matter.js then drops the attribute writes with a warning only (#464).
// ponytail: plain chain, an endpoint whose construction never settles queues
// its later updates. Add a timeout around the write if that ever shows up.
const chains = new WeakMap<Endpoint, Promise<void>>();

/**
 * Errors a closed, rebuilt or not yet attached endpoint throws on a late
 * flush. The endpoint is gone, so the update is dropped instead of becoming
 * an unhandled rejection (#450, #461).
 */
export function isDetachedEndpointError(error: unknown): boolean {
  if (
    error instanceof TransactionDestroyedError ||
    error instanceof DestroyedDependencyError
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Endpoint storage inaccessible") ||
    message.includes("is not present on this endpoint")
  );
}

/** Push one Home Assistant state onto an endpoint, serialized per endpoint. */
export function updateEntityState(
  endpoint: Endpoint,
  state: HomeAssistantEntityState,
): Promise<void> {
  const next = (chains.get(endpoint) ?? Promise.resolve()).then(() =>
    writeState(endpoint, state),
  );
  // a failed write must not block the next one, keep a settled link
  chains.set(
    endpoint,
    next.catch(() => {}),
  );
  return next;
}

async function writeState(
  endpoint: Endpoint,
  state: HomeAssistantEntityState,
): Promise<void> {
  try {
    await endpoint.construction.ready;
  } catch {
    // construction failed, the endpoint is unusable
    return;
  }
  try {
    const current = endpoint.stateOf(HomeAssistantEntityBehavior).entity;
    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: { ...current, state },
    });
  } catch (error) {
    if (isDetachedEndpointError(error)) return;
    throw error;
  }
}
