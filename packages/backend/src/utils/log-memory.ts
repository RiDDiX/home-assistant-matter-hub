import os from "node:os";
import v8 from "node:v8";
import type { Logger } from "@matter/general";

// Stop creating new endpoints when heap usage exceeds this fraction of the limit.
const HEAP_PRESSURE_THRESHOLD = 0.85;

// Warn at startup when free system memory is below this threshold (in MB).
const LOW_MEMORY_THRESHOLD_MB = 512;

/**
 * Log current heap memory usage. Useful for diagnosing OOM issues during startup.
 * Reports heap used / heap total in MB.
 */
export function logMemoryUsage(log: Logger, context: string): void {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  log.debug(
    `Memory [${context}]: heap ${heapUsedMB}/${heapTotalMB} MB, rss ${rssMB} MB`,
  );
}

/**
 * Check if the V8 heap is under memory pressure.
 * Returns true when heap usage exceeds 85% of the configured heap limit.
 * Used to stop loading more endpoints before hitting an OOM crash.
 */
export function isHeapUnderPressure(): boolean {
  const stats = v8.getHeapStatistics();
  return stats.used_heap_size / stats.heap_size_limit > HEAP_PRESSURE_THRESHOLD;
}

/**
 * Log a startup warning when free system memory is below a safe threshold.
 * Helps users on Raspberry Pi / low-resource devices understand why bridges
 * may fail to start or get OOM-killed.
 */
export function logStartupMemoryGuard(log: Logger): void {
  const totalMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeMB = Math.round(os.freemem() / 1024 / 1024);
  const heapLimitMB = Math.round(
    v8.getHeapStatistics().heap_size_limit / 1024 / 1024,
  );

  log.info(
    `System memory: ${freeMB} MB free / ${totalMB} MB total, heap limit: ${heapLimitMB} MB`,
  );

  if (freeMB < LOW_MEMORY_THRESHOLD_MB) {
    log.warn(
      `Low memory detected (${freeMB} MB free). ` +
        "HAMH typically needs 400-600 MB. " +
        "Consider reducing the number of entities per bridge, " +
        "stopping memory-heavy add-ons, or increasing available RAM. " +
        "See the FAQ section 'The app keeps crashing or restarting' for details.",
    );
  }
}
