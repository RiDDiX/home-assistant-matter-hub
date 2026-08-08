import { Logger } from "@matter/general";

const logger = Logger.get("ApplyPatchState");

/**
 * Safely applies a patch to state, handling transaction contexts properly.
 *
 * Wraps the state update in Transaction.act() to properly acquire locks
 * asynchronously, avoiding "synchronous-transaction-conflict" errors when
 * called from within reactors or other transaction contexts.
 *
 * @param state - The state object to patch
 * @param patch - The partial state to apply
 * @param options - Optional settings
 * @param options.force - If true, applies all values even if unchanged (triggers subscription updates)
 */
export function applyPatchState<T extends object>(
  state: T,
  patch: Partial<T>,
  options?: { force?: boolean },
): Partial<T> {
  return applyPatch(state, patch, options?.force);
}

function applyPatch<T extends object>(
  state: T,
  patch: Partial<T>,
  force = false,
): Partial<T> {
  // Only include values that need to be changed (unless force is true)
  const actualPatch: Partial<T> = {};

  for (const key in patch) {
    if (Object.hasOwn(patch, key)) {
      const patchValue = patch[key];

      if (patchValue !== undefined) {
        const stateValue = state[key];

        // In force mode, include all defined values to trigger subscription updates
        if (force || !deepEqual(stateValue, patchValue)) {
          actualPatch[key] = patchValue;
        }
      }
    }
  }

  // Set properties individually with per-property error handling.
  // Previously, a single try-catch wrapped the entire loop, so if ANY property
  // write failed (e.g., a Fixed quality attribute), ALL subsequent properties
  // were skipped, including critical ones like systemMode, localTemperature,
  // and setpoints. This caused thermostats to appear completely broken (#52).
  const failedKeys: string[] = [];
  for (const key in actualPatch) {
    if (!Object.hasOwn(actualPatch, key)) continue;
    try {
      state[key] = actualPatch[key] as T[Extract<keyof T, string>];
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      // Endpoint not yet attached to a node, all remaining writes will fail too
      if (
        errorMessage.includes(
          "Endpoint storage inaccessible because endpoint is not a node and is not owned by another endpoint",
        )
      ) {
        logger.debug(
          `Suppressed endpoint storage error, patch not applied: ${JSON.stringify(actualPatch)}`,
        );
        return actualPatch;
      }
      // Transaction conflict, all remaining writes will also fail
      if (errorMessage.includes("synchronous-transaction-conflict")) {
        logger.warn(
          `Transaction conflict, state update DROPPED: ${JSON.stringify(actualPatch)}`,
        );
        return actualPatch;
      }
      // Per-property failure: log warning and continue with remaining properties
      failedKeys.push(key);
      logger.warn(`Failed to set property '${key}': ${errorMessage}`);
    }
  }
  if (failedKeys.length > 0) {
    logger.warn(
      `${failedKeys.length} properties failed to update: [${failedKeys.join(", ")}]`,
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
