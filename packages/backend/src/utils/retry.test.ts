import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, withRetry } from "./retry.js";

describe("withRetry", () => {
  it("should return the result on first success", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("should retry on failure and succeed", async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return Promise.resolve("ok");
      },
      { maxAttempts: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("should throw after all retries exhausted", async () => {
    await expect(
      withRetry(() => Promise.reject(new Error("permanent")), {
        maxAttempts: 2,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow("permanent");
  });

  it("should call onRetry callback", async () => {
    const onRetry = vi.fn();
    let attempt = 0;
    await withRetry(
      () => {
        attempt++;
        if (attempt < 2) throw new Error("retry me");
        return Promise.resolve("done");
      },
      { maxAttempts: 3, baseDelayMs: 1, onRetry },
    );
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0][0]).toBe(1);
  });

  it("should respect maxDelayMs", async () => {
    const onRetry = vi.fn();
    let attempt = 0;
    await withRetry(
      () => {
        attempt++;
        if (attempt < 3) throw new Error("fail");
        return Promise.resolve("ok");
      },
      {
        maxAttempts: 3,
        baseDelayMs: 5000,
        maxDelayMs: 10,
        backoffMultiplier: 10,
        onRetry,
      },
    );
    for (const call of onRetry.mock.calls) {
      expect(call[2]).toBeLessThanOrEqual(10);
    }
  });
});

describe("CircuitBreaker", () => {
  it("should allow calls in closed state", async () => {
    const cb = new CircuitBreaker(3, 100);
    const result = await cb.execute(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(cb.isOpen).toBe(false);
  });

  it("should open after reaching failure threshold", async () => {
    const cb = new CircuitBreaker(2, 100);
    for (let i = 0; i < 2; i++) {
      await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    }
    expect(cb.isOpen).toBe(true);
  });

  it("should reject calls when open", async () => {
    const cb = new CircuitBreaker(1, 60000);
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    expect(cb.isOpen).toBe(true);
    await expect(cb.execute(() => Promise.resolve("ok"))).rejects.toThrow(
      "Circuit breaker is open",
    );
  });

  it("should transition to half-open after reset timeout", async () => {
    const cb = new CircuitBreaker(1, 1);
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    expect(cb.isOpen).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const result = await cb.execute(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(cb.isOpen).toBe(false);
  });

  it("should close again after successful half-open call", async () => {
    const cb = new CircuitBreaker(1, 1);
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    await cb.execute(() => Promise.resolve("ok"));
    expect(cb.isOpen).toBe(false);
    const result = await cb.execute(() => Promise.resolve("stable"));
    expect(result).toBe("stable");
  });

  it("should reset manually", async () => {
    const cb = new CircuitBreaker(1, 60000);
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    expect(cb.isOpen).toBe(true);
    cb.reset();
    expect(cb.isOpen).toBe(false);
    const result = await cb.execute(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });
});
