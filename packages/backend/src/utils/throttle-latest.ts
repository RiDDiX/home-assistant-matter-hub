export interface ThrottledFn<T extends unknown[]> {
  (...args: T): void;
  clear(): void;
}

// Run fn at most once per intervalMs: the first call fires straight away, rapid
// follow-ups are coalesced into a single trailing call with the latest args so
// the final value always lands. Used to cap Matter writes from chatty sensors
// that otherwise report on every tick (#351).
export function throttleLatest<T extends unknown[]>(
  fn: (...args: T) => void,
  intervalMs: number,
): ThrottledFn<T> {
  let lastRun = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: T | undefined;

  const run = (args: T) => {
    lastRun = Date.now();
    fn(...args);
  };

  const throttled = ((...args: T) => {
    const elapsed = Date.now() - lastRun;
    if (elapsed >= intervalMs) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = undefined;
      run(args);
      return;
    }
    pending = args;
    if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        if (pending) {
          const next = pending;
          pending = undefined;
          run(next);
        }
      }, intervalMs - elapsed);
    }
  }) as ThrottledFn<T>;

  throttled.clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending = undefined;
  };

  return throttled;
}
