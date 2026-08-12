export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /** Return false to give up immediately, e.g. for a call that may have landed. */
  shouldRetry?: (error: unknown) => boolean;
}

const defaultOptions: Required<Omit<RetryOptions, "onRetry" | "shouldRetry">> =
  {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
  };

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (
        attempt === opts.maxAttempts ||
        options.shouldRetry?.(error) === false
      ) {
        break;
      }

      const delayMs = Math.min(
        opts.baseDelayMs * opts.backoffMultiplier ** (attempt - 1),
        opts.maxDelayMs,
      );

      opts.onRetry?.(attempt, error, delayMs);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 30000,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = "open";
    }
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  // Open AND still inside the reset window. Callers that pre-check
  // availability must use this, not isOpen, or the half-open probe never
  // happens and the breaker stays latched forever (#446).
  get isBlocking(): boolean {
    return (
      this.state === "open" &&
      Date.now() - this.lastFailureTime < this.resetTimeoutMs
    );
  }

  reset(): void {
    this.failures = 0;
    this.state = "closed";
  }
}
