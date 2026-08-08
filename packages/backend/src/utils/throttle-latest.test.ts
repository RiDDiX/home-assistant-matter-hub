import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttleLatest } from "./throttle-latest.js";

describe("throttleLatest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first call immediately", () => {
    const fn = vi.fn();
    const t = throttleLatest(fn, 1000);
    t("a");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("a");
  });

  it("coalesces a burst into one trailing call with the latest value", () => {
    const fn = vi.fn();
    const t = throttleLatest(fn, 1000);
    t("a"); // leading
    vi.advanceTimersByTime(100);
    t("b");
    vi.advanceTimersByTime(100);
    t("c");
    expect(fn).toHaveBeenCalledTimes(1); // still just the leading call
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("c");
  });

  it("caps the rate far below the call rate", () => {
    const fn = vi.fn();
    const t = throttleLatest(fn, 1000);
    // 50 calls, one every 40ms (~2 seconds of a chatty sensor)
    for (let i = 0; i < 50; i++) {
      t(i);
      vi.advanceTimersByTime(40);
    }
    vi.advanceTimersByTime(1000);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(4);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("clear() cancels a pending trailing call", () => {
    const fn = vi.fn();
    const t = throttleLatest(fn, 1000);
    t("a"); // leading
    vi.advanceTimersByTime(100);
    t("b"); // pending trailing
    t.clear();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
