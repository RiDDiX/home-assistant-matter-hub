import { Logger } from "@matter/general";

const logger = Logger.get("SafePluginRunner");

/** Default timeout for plugin async calls (ms) */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Number of consecutive failures before a plugin is disabled */
const CIRCUIT_BREAKER_THRESHOLD = 3;

export interface CircuitBreakerState {
  failures: number;
  disabled: boolean;
  lastError?: string;
  disabledAt?: number;
}

/**
 * Wraps plugin lifecycle calls with:
 * - Timeout (rejects if plugin hangs)
 * - Try/catch (catches sync throws)
 * - Circuit breaker (disables after N consecutive failures)
 *
 * Plugins run in-process because they need direct access to matter.js
 * Endpoint objects (structured clone cannot serialize them). Isolation
 * is achieved via defensive wrappers, not OS-level sandboxing.
 *
 * Limitation: fire-and-forget promises created by plugins (e.g. inside
 * setTimeout callbacks) escape this runner's scope. The caller should
 * ensure a process-level unhandledRejection handler exists to prevent
 * crashes from such cases.
 */
export class SafePluginRunner {
  private readonly states = new Map<string, CircuitBreakerState>();

  getState(pluginName: string): CircuitBreakerState {
    let state = this.states.get(pluginName);
    if (!state) {
      state = { failures: 0, disabled: false };
      this.states.set(pluginName, state);
    }
    return state;
  }

  isDisabled(pluginName: string): boolean {
    return this.getState(pluginName).disabled;
  }

  /**
   * Re-enable a previously disabled plugin (e.g., after user action).
   */
  resetCircuitBreaker(pluginName: string): void {
    const state = this.getState(pluginName);
    state.failures = 0;
    state.disabled = false;
    state.lastError = undefined;
    state.disabledAt = undefined;
  }

  /**
   * Run a plugin function with timeout + circuit breaker.
   * Returns the result or undefined if the call failed/was skipped.
   */
  async run<T>(
    pluginName: string,
    operation: string,
    fn: () => Promise<T> | T,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T | undefined> {
    const state = this.getState(pluginName);
    if (state.disabled) {
      logger.debug(
        `Plugin "${pluginName}" is disabled (circuit breaker open), skipping ${operation}`,
      );
      return undefined;
    }

    const timeout = this.createTimeout<T>(pluginName, operation, timeoutMs);
    try {
      const result = await Promise.race([
        Promise.resolve().then(fn),
        timeout.promise,
      ]);

      // Success: reset failure count
      timeout.clear();
      state.failures = 0;
      return result;
    } catch (error) {
      timeout.clear();
      state.failures++;
      state.lastError = error instanceof Error ? error.message : String(error);

      logger.error(
        `Plugin "${pluginName}" failed during ${operation} (failure ${state.failures}/${CIRCUIT_BREAKER_THRESHOLD}): ${state.lastError}`,
      );

      if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
        state.disabled = true;
        state.disabledAt = Date.now();
        logger.error(
          `Plugin "${pluginName}" DISABLED after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures. Last error: ${state.lastError}`,
        );
      }

      return undefined;
    }
  }

  /**
   * Run a synchronous plugin function with try/catch + circuit breaker.
   */
  runSync<T>(
    pluginName: string,
    operation: string,
    fn: () => T,
  ): T | undefined {
    const state = this.getState(pluginName);
    if (state.disabled) {
      return undefined;
    }

    try {
      const result = fn();
      state.failures = 0;
      return result;
    } catch (error) {
      state.failures++;
      state.lastError = error instanceof Error ? error.message : String(error);

      logger.error(
        `Plugin "${pluginName}" failed during ${operation} (sync, failure ${state.failures}/${CIRCUIT_BREAKER_THRESHOLD}): ${state.lastError}`,
      );

      if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
        state.disabled = true;
        state.disabledAt = Date.now();
        logger.error(
          `Plugin "${pluginName}" DISABLED after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures.`,
        );
      }

      return undefined;
    }
  }

  getAllStates(): Map<string, CircuitBreakerState> {
    return new Map(this.states);
  }

  private createTimeout<T>(
    pluginName: string,
    operation: string,
    timeoutMs: number,
  ): { promise: Promise<T>; clear: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Plugin "${pluginName}" timed out during ${operation} after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });
    return { promise, clear: () => clearTimeout(timer) };
  }
}
