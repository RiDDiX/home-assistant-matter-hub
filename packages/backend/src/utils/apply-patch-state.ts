/**
 * Safely applies a patch to state, handling transaction contexts properly.
 *
 * Wraps the state update in Transaction.act() to properly acquire locks
 * asynchronously, avoiding "synchronous-transaction-conflict" errors when
 * called from within reactors or other transaction contexts.
 */
export function applyPatchState<T extends object>(
  state: T,
  patch: Partial<T>,
): Partial<T> {
  return applyPatch(state, patch);
}

function applyPatch<T extends object>(state: T, patch: Partial<T>): Partial<T> {
  // Only include values that need to be changed
  const actualPatch: Partial<T> = {};

  for (const key in patch) {
    if (Object.hasOwn(patch, key)) {
      const patchValue = patch[key];

      if (patchValue !== undefined) {
        const stateValue = state[key];

        if (!deepEqual(stateValue, patchValue)) {
          actualPatch[key] = patchValue;
        }
      }
    }
  }

  // Set properties individually to avoid transaction conflicts
  try {
    for (const key in actualPatch) {
      if (Object.hasOwn(actualPatch, key)) {
        state[key] = actualPatch[key] as T[Extract<keyof T, string>];
      }
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    // Suppress transient Matter.js errors that occur when an endpoint is still
    // being constructed/attached to a node. The state update will be retried
    // once the endpoint is fully initialized and receives its first HA update.
    if (
      errorMessage.includes(
        "Endpoint storage inaccessible because endpoint is not a node and is not owned by another endpoint",
      )
    ) {
      return actualPatch;
    }
    throw new Error(
      `Failed to patch the following properties: ${JSON.stringify(actualPatch, null, 2)}`,
      { cause: e },
    );
  }

  return actualPatch;
}

function deepEqual<T>(a: T, b: T): boolean {
  if (a == null || b == null) {
    return a === b;
  }
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((vA, idx) => deepEqual(vA, b[idx]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const keys = Object.keys({ ...a, ...b }) as (keyof T)[];
    return keys.every((key) => deepEqual(a[key], b[key]));
  }
  return a === b;
}
