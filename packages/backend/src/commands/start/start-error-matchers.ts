function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    // HA WebSocket error: { type: 'result', success: false, error: { code: N, message: '...' } }
    if (typeof obj.error === "object" && obj.error !== null) {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
    }
    if (typeof obj.message === "string") return obj.message;
  }
  return String(error);
}

// Matches endpoint paths inside the aggregator subtree, anchored on the 32-hex
// bridge id. Also hits the endpoint-terminal "<bridgeId>.aggregator" form a
// part emits when the aggregator itself is still under construction (#435).
const AGGREGATOR_PATH_RE = /[0-9a-f]{32}\.aggregator\b/i;

// Check if an error should be suppressed (not crash the process)
export function shouldSuppressError(error: unknown): boolean {
  const msg = extractErrorMessage(error);
  return (
    msg.includes("Connection lost") ||
    msg.includes("Endpoint storage inaccessible") ||
    msg.includes("Invalid intervalMs") ||
    msg.includes("generalDiagnostics") ||
    msg.includes("Behaviors have errors") ||
    msg.includes("TransactionDestroyedError") ||
    msg.includes("DestroyedDependencyError") ||
    msg.includes("UninitializedDependencyError") ||
    msg.includes("mutex-closed") ||
    msg.includes("not a node and is not owned") ||
    msg.includes("aggregator.") ||
    AGGREGATOR_PATH_RE.test(msg)
  );
}

// Check if an error is isolatable (can isolate the entity causing it)
export function isIsolatableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("Invalid intervalMs") ||
    msg.includes("Behaviors have errors") ||
    msg.includes("TransactionDestroyedError") ||
    msg.includes("DestroyedDependencyError") ||
    msg.includes("UninitializedDependencyError") ||
    msg.includes("Endpoint storage inaccessible") ||
    msg.includes("aggregator.") ||
    AGGREGATOR_PATH_RE.test(msg)
  );
}
