import type {
  HomeAssistantDeviceRegistry,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
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

/**
 * Push a fresh Home Assistant registry snapshot onto an endpoint, serialized on
 * the same per-endpoint chain as the state writes.
 *
 * updateEntityState only replaces `state`, so `registry` and `deviceRegistry`
 * stayed frozen at the values the endpoint was built with. A device renamed in
 * Home Assistant, or its manufacturer, model or firmware version changing, then
 * never reached the Matter attributes until the bridge restarted (#467).
 *
 * NodeLabel is writable and follows immediately. VendorName, ProductName,
 * SerialNumber and the version strings are fixed quality, so a controller that
 * cached them at pairing keeps its copy until it re-reads the node. The values
 * are corrected here either way, deliberately without touching the node's
 * configuration version: forcing every controller to re-enumerate the whole
 * bridge over a renamed device costs more than the stale string it fixes.
 */
export function updateEntityRegistry(
  endpoint: Endpoint,
  registry: HomeAssistantEntityRegistry | undefined,
  deviceRegistry: HomeAssistantDeviceRegistry | undefined,
): Promise<void> {
  const next = (chains.get(endpoint) ?? Promise.resolve()).then(() =>
    writeRegistry(endpoint, registry, deviceRegistry),
  );
  chains.set(
    endpoint,
    next.catch(() => {}),
  );
  return next;
}

async function writeRegistry(
  endpoint: Endpoint,
  registry: HomeAssistantEntityRegistry | undefined,
  deviceRegistry: HomeAssistantDeviceRegistry | undefined,
): Promise<void> {
  try {
    await endpoint.construction.ready;
  } catch {
    return;
  }
  try {
    const current = endpoint.stateOf(HomeAssistantEntityBehavior).entity;
    // The registry hands out fresh objects on every reload, so compare by value
    // or every poll would take the endpoint lock for an identical write.
    if (
      JSON.stringify(current.registry) === JSON.stringify(registry) &&
      JSON.stringify(current.deviceRegistry) === JSON.stringify(deviceRegistry)
    ) {
      return;
    }
    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: { ...current, registry, deviceRegistry },
    });
  } catch (error) {
    if (isDetachedEndpointError(error)) return;
    throw error;
  }
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
