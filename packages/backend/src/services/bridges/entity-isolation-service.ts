import type { FailedEntity } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";

const logger = Logger.get("EntityIsolation");

/**
 * Tracks and isolates entities that throw at runtime so the bridge keeps
 * running when individual entities hit issues (e.g. Invalid intervalMs
 * from subscription timing).
 */
class EntityIsolationServiceImpl {
  private isolatedEntities: Map<string, FailedEntity> = new Map();
  private isolationCallbacks: Map<string, (entityId: string) => Promise<void>> =
    new Map();

  /**
   * Register a callback to be called when an entity needs to be isolated.
   * The callback should remove the entity from the bridge's aggregator.
   */
  registerIsolationCallback(
    bridgeId: string,
    callback: (entityId: string) => Promise<void>,
  ) {
    this.isolationCallbacks.set(bridgeId, callback);
  }

  unregisterIsolationCallback(bridgeId: string) {
    this.isolationCallbacks.delete(bridgeId);
  }

  /**
   * Parse the endpoint path from a Matter.js error message and extract the entity name.
   * Example path: "ed5b4f8d042e4599b833f21da4ededba.aggregator.Küchenlicht.onOff.on"
   * Returns: { bridgeId: "ed5b4f8d...", entityName: "Küchenlicht" }
   */
  parseEndpointPath(errorMessage: string): {
    bridgeId: string;
    entityName: string;
  } | null {
    // Match pattern: bridgeId.aggregator.entityName[.cluster.attribute]
    // The trailing segments are optional, a part that fails during construction
    // is named without them.
    const match = errorMessage.match(/([a-f0-9]{32})\.aggregator\.([^.\s>]+)/i);
    if (match) {
      return {
        bridgeId: match[1],
        entityName: match[2],
      };
    }
    return null;
  }

  private classifyError(msg: string): string | null {
    if (msg.includes("Invalid intervalMs")) {
      return "Subscription timing error (Invalid intervalMs)";
    }
    if (msg.includes("Behaviors have errors")) {
      return "Behavior initialization failure";
    }
    if (msg.includes("TransactionDestroyedError")) {
      return "Transaction destroyed during operation";
    }
    if (msg.includes("DestroyedDependencyError")) {
      return "Dependency destroyed during operation";
    }
    if (msg.includes("UninitializedDependencyError")) {
      return "Uninitialized dependency access";
    }
    if (msg.includes("Endpoint storage inaccessible")) {
      return "Endpoint storage inaccessible";
    }
    if (msg.includes("Error initializing part")) {
      return "Endpoint construction failure";
    }
    if (msg.includes("aggregator.")) {
      return "Runtime error in endpoint";
    }
    return null;
  }

  /**
   * Attempt to isolate an entity based on an error.
   * Returns true if the entity was successfully identified and isolation was triggered.
   */
  async isolateFromError(error: unknown): Promise<boolean> {
    const msg = error instanceof Error ? error.message : String(error);

    const classification = this.classifyError(msg);
    if (!classification) {
      return false;
    }

    const parsed = this.parseEndpointPath(msg);
    if (!parsed) {
      logger.warn("Could not parse entity from error:", msg);
      return false;
    }

    const { bridgeId, entityName } = parsed;

    // Check if we have a callback registered for this bridge
    const callback = this.isolationCallbacks.get(bridgeId);
    if (!callback) {
      logger.warn(
        `No isolation callback registered for bridge ${bridgeId}, entity: ${entityName}`,
      );
      return false;
    }

    // Check if already isolated
    const key = `${bridgeId}:${entityName}`;
    if (this.isolatedEntities.has(key)) {
      return true; // Already isolated
    }

    const reason = `${classification}. Entity isolated to protect bridge stability.`;
    this.isolatedEntities.set(key, {
      entityId: entityName,
      reason,
      failedAt: new Date().toISOString(),
    });

    logger.warn(
      `Isolating entity "${entityName}" from bridge ${bridgeId} due to: ${reason}`,
    );
    diagnosticEventBus.emit("entity_error", `Entity isolated: ${entityName}`, {
      bridgeId,
      entityId: entityName,
      details: { reason: classification },
    });

    try {
      await callback(entityName);
      return true;
    } catch (e) {
      logger.error(`Failed to isolate entity ${entityName}:`, e);
      return false;
    }
  }

  /**
   * Get all isolated entities for a specific bridge.
   */
  getIsolatedEntities(bridgeId: string): FailedEntity[] {
    const result: FailedEntity[] = [];
    for (const [key, entity] of this.isolatedEntities) {
      if (key.startsWith(`${bridgeId}:`)) {
        result.push(entity);
      }
    }
    return result;
  }

  /**
   * Clear isolated entities for a bridge (e.g., on restart).
   */
  clearIsolatedEntities(bridgeId: string) {
    for (const key of this.isolatedEntities.keys()) {
      if (key.startsWith(`${bridgeId}:`)) {
        this.isolatedEntities.delete(key);
      }
    }
  }
}

// Singleton instance
export const EntityIsolationService = new EntityIsolationServiceImpl();
