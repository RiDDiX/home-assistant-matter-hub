import { Logger } from "@matter/general";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeStorage } from "../storage/bridge-storage.js";
import type { Bridge } from "./bridge.js";
import type { BridgeFactory } from "./bridge-factory.js";
import { BridgeService, type BridgeServiceProps } from "./bridge-service.js";

// start() resolves even when the bridge fails again, only the status tells
function makeBridge(id: string, status: string, statusAfterStart = "running") {
  const bridge = {
    id,
    data: { status, name: id },
    start: vi.fn(async () => {
      bridge.data.status = statusAfterStart;
    }),
  };
  return bridge;
}

// autoRecovery off keeps initialize() from starting a timer the tests would leak.
async function makeService(): Promise<BridgeService> {
  const svc = new BridgeService(
    { bridges: [], add: vi.fn(), remove: vi.fn() } as unknown as BridgeStorage,
    {} as unknown as BridgeFactory,
    {
      basicInformation: {},
      autoRecovery: false,
    } as unknown as BridgeServiceProps,
  );
  await svc.construction;
  return svc;
}

describe("BridgeService recovery", () => {
  it("only restarts failed bridges, never healthy ones", async () => {
    const svc = await makeService();
    svc.autoRecoveryEnabled = true;
    const failed = makeBridge("a", "failed");
    const running = makeBridge("b", "running");
    svc.bridges.push(failed as unknown as Bridge, running as unknown as Bridge);

    svc.recoverFailedBridgesNow();

    await vi.waitFor(() => expect(failed.start).toHaveBeenCalledTimes(1));
    expect(running.start).not.toHaveBeenCalled();
  });

  it("records a recovery attempt in the history", async () => {
    const svc = await makeService();
    svc.autoRecoveryEnabled = true;
    const failed = makeBridge("a", "failed");
    svc.bridges.push(failed as unknown as Bridge);

    svc.recoverFailedBridgesNow();

    await vi.waitFor(() => expect(svc.recoveryHistory).toHaveLength(1));
    expect(svc.recoveryHistory[0]).toMatchObject({
      bridgeId: "a",
      outcome: "success",
    });
  });

  it("records a failed outcome when the bridge fails again", async () => {
    const svc = await makeService();
    svc.autoRecoveryEnabled = true;
    const failed = makeBridge("a", "failed", "failed");
    svc.bridges.push(failed as unknown as Bridge);

    svc.recoverFailedBridgesNow();

    await vi.waitFor(() => expect(svc.recoveryHistory).toHaveLength(1));
    expect(svc.recoveryHistory[0]).toMatchObject({
      bridgeId: "a",
      outcome: "failed",
    });
    expect(svc.recoveryCount).toBe(0);
  });

  it("debounces back-to-back reactive triggers", async () => {
    const svc = await makeService();
    svc.autoRecoveryEnabled = true;
    const failed = makeBridge("a", "failed");
    svc.bridges.push(failed as unknown as Bridge);

    svc.recoverFailedBridgesNow();
    svc.recoverFailedBridgesNow();

    await vi.waitFor(() => expect(failed.start).toHaveBeenCalledTimes(1));
    expect(failed.start).toHaveBeenCalledTimes(1);
  });

  it("applyRecoverySettings updates the live settings", async () => {
    const svc = await makeService();
    svc.applyRecoverySettings({
      autoRecoveryEnabled: false,
      recoveryIntervalMs: 30_000,
    });
    expect(svc.recoverySettings).toEqual({
      autoRecoveryEnabled: false,
      recoveryIntervalMs: 30_000,
    });
  });

  it("clamps a bad interval so the timer can never tight-loop", async () => {
    const svc = await makeService();
    svc.applyRecoverySettings({
      autoRecoveryEnabled: false,
      recoveryIntervalMs: 0,
    });
    expect(svc.recoverySettings.recoveryIntervalMs).toBeGreaterThanOrEqual(
      10_000,
    );
  });

  it("does not run reactive recovery while disabled", async () => {
    const svc = await makeService();
    const failed = makeBridge("a", "failed");
    svc.bridges.push(failed as unknown as Bridge);

    svc.recoverFailedBridgesNow();

    expect(failed.start).not.toHaveBeenCalled();
  });
});

function makeRefreshBridge(id: string) {
  return {
    id,
    data: { status: "running", name: id },
    refreshDevices: vi.fn(async () => true),
    start: vi.fn(async () => {}),
  };
}

function never() {
  return new Promise<void>(() => {});
}

function makeDeletableBridge(id: string) {
  let stopped = () => {};
  const bridge = {
    ...makeRefreshBridge(id),
    stop: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          stopped = resolve;
        }),
    ),
    delete: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return { bridge, finishStop: () => stopped() };
}

function hangFirstRefresh(bridge: ReturnType<typeof makeRefreshBridge>) {
  let release = () => {};
  bridge.refreshDevices.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  );
  return () => release();
}

describe("BridgeService refreshAll", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports false when a bridge throws or is incomplete, still refreshing the others", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    const svc = await makeService();
    const a = makeRefreshBridge("a");
    const b = makeRefreshBridge("b");
    svc.bridges.push(a as unknown as Bridge, b as unknown as Bridge);
    await expect(svc.refreshAll()).resolves.toBe(true);

    a.refreshDevices.mockRejectedValueOnce(new Error("boom"));
    await expect(svc.refreshAll()).resolves.toBe(false);
    expect(b.refreshDevices).toHaveBeenCalledTimes(2);

    a.refreshDevices.mockResolvedValueOnce(false);
    await expect(svc.refreshAll()).resolves.toBe(false);
    expect(b.refreshDevices).toHaveBeenCalledTimes(3);

    await expect(svc.refreshAll()).resolves.toBe(true);
  });

  it("abandons a hung refresh, skips the bridge until it settled and follows up once", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const svc = await makeService();
    vi.useFakeTimers();
    const changed = vi.fn();
    svc.onBridgeChanged = changed;
    const incomplete = vi.fn();
    svc.onRefreshIncomplete = incomplete;
    const a = makeRefreshBridge("a");
    const b = makeRefreshBridge("b");
    let release = () => {};
    a.refreshDevices.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    svc.bridges.push(a as unknown as Bridge, b as unknown as Bridge);

    const first = svc.refreshAll();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toBe(true);
    expect(b.refreshDevices).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalledWith("a");
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("bridge a")),
    ).toHaveLength(1);

    await expect(svc.refreshAll()).resolves.toBe(true);
    expect(a.refreshDevices).toHaveBeenCalledTimes(1);
    expect(b.refreshDevices).toHaveBeenCalledTimes(2);

    release();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("a"));
    expect(a.refreshDevices).toHaveBeenCalledTimes(2);
    await expect(svc.refreshAll()).resolves.toBe(true);
    expect(a.refreshDevices).toHaveBeenCalledTimes(3);
    expect(incomplete).not.toHaveBeenCalled();
  });

  it("logs a hung refresh that fails late and skips the follow-up once the bridge is gone", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    const svc = await makeService();
    vi.useFakeTimers();
    const changed = vi.fn();
    svc.onBridgeChanged = changed;
    const a = makeRefreshBridge("a");
    let fail = (_e: Error) => {};
    a.refreshDevices.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          fail = reject;
        }),
    );
    svc.bridges.push(a as unknown as Bridge);

    const first = svc.refreshAll();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toBe(true);

    svc.bridges.splice(svc.bridges.indexOf(a as unknown as Bridge), 1);
    const late = new Error("late");
    fail(late);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("Failed to refresh bridge a:", late),
    );

    const again = makeRefreshBridge("a");
    svc.bridges.push(again as unknown as Bridge);
    await vi.waitFor(async () => {
      await expect(svc.refreshAll()).resolves.toBe(true);
      expect(again.refreshDevices).toHaveBeenCalled();
    });
    expect(again.refreshDevices).toHaveBeenCalledTimes(1);
    expect(a.refreshDevices).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("follow-up"))],
    ["is incomplete", () => Promise.resolve(false)],
  ])("notifies once when the follow-up refresh %s", async (label, followUp: () => Promise<boolean>) => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    const svc = await makeService();
    vi.useFakeTimers();
    const changed = vi.fn();
    svc.onBridgeChanged = changed;
    const incomplete = vi.fn();
    svc.onRefreshIncomplete = incomplete;
    const a = makeRefreshBridge("a");
    let release = () => {};
    a.refreshDevices
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true);
          }),
      )
      .mockImplementationOnce(followUp);
    svc.bridges.push(a as unknown as Bridge);

    const first = svc.refreshAll();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toBe(true);

    release();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("a"));
    expect(a.refreshDevices).toHaveBeenCalledTimes(2);
    expect(incomplete).toHaveBeenCalledTimes(1);
    const stillIncomplete = warn.mock.calls.filter((c) =>
      String(c[0]).includes("still incomplete"),
    );
    const failures = error.mock.calls.filter(
      (c) => c[0] === "Failed to refresh bridge a:",
    );
    if (label === "rejects") {
      expect(failures).toHaveLength(1);
      expect(stillIncomplete).toHaveLength(0);
    } else {
      expect(failures).toHaveLength(0);
      expect(stillIncomplete).toHaveLength(1);
    }

    await vi.waitFor(async () => {
      await svc.refreshAll();
      expect(a.refreshDevices).toHaveBeenCalledTimes(3);
    });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(incomplete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["repeats once when a pass skipped the bridge during it", true],
    ["runs once when no pass skipped the bridge", false],
  ])("the follow-up refresh %s", async (_label, skipDuringFollowUp) => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const svc = await makeService();
    vi.useFakeTimers();
    const changed = vi.fn();
    svc.onBridgeChanged = changed;
    const a = makeRefreshBridge("a");
    let release = () => {};
    let finishFollowUp = () => {};
    a.refreshDevices
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishFollowUp = () => resolve(true);
          }),
      );
    svc.bridges.push(a as unknown as Bridge);

    const first = svc.refreshAll();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toBe(true);

    release();
    await vi.waitFor(() => expect(a.refreshDevices).toHaveBeenCalledTimes(2));
    if (skipDuringFollowUp) {
      await expect(svc.refreshAll()).resolves.toBe(true);
      expect(a.refreshDevices).toHaveBeenCalledTimes(2);
    }

    finishFollowUp();
    const followUps = skipDuringFollowUp ? 2 : 1;
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(followUps));
    expect(a.refreshDevices).toHaveBeenCalledTimes(1 + followUps);
    await expect(svc.refreshAll()).resolves.toBe(true);
    expect(a.refreshDevices).toHaveBeenCalledTimes(2 + followUps);
    expect(changed).toHaveBeenCalledTimes(1 + followUps);
  });

  it("skips the follow-up refresh of a bridge that is being deleted", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const svc = await makeService();
    vi.useFakeTimers();
    const changed = vi.fn();
    svc.onBridgeChanged = changed;
    const { bridge: a, finishStop } = makeDeletableBridge("a");
    const release = hangFirstRefresh(a);
    svc.bridges.push(a as unknown as Bridge);

    const first = svc.refreshAll();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toBe(true);

    const deleted = svc.delete("a");
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(a.refreshDevices).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();

    finishStop();
    await deleted;
    expect(changed).toHaveBeenCalledTimes(1);
    const again = makeRefreshBridge("a");
    svc.bridges.push(again as unknown as Bridge);
    await expect(svc.refreshAll()).resolves.toBe(true);
    expect(again.refreshDevices).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a bridge that is being deleted", async () => {
    const svc = await makeService();
    const { bridge: a, finishStop } = makeDeletableBridge("a");
    const b = makeRefreshBridge("b");
    svc.bridges.push(a as unknown as Bridge, b as unknown as Bridge);

    const deleted = svc.delete("a");
    await expect(svc.refreshAll()).resolves.toBe(true);
    expect(a.refreshDevices).not.toHaveBeenCalled();
    expect(b.refreshDevices).toHaveBeenCalledTimes(1);

    finishStop();
    await deleted;
  });

  it("logs a throwing change listener in the follow-up refresh", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const svc = await makeService();
      vi.useFakeTimers();
      const boom = new Error("listener");
      const changed = vi.fn().mockImplementationOnce(() => {
        throw boom;
      });
      svc.onBridgeChanged = changed;
      const a = makeRefreshBridge("a");
      const release = hangFirstRefresh(a);
      svc.bridges.push(a as unknown as Bridge);

      const first = svc.refreshAll();
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(first).resolves.toBe(true);

      release();
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith("Failed to refresh bridge a:", boom),
      );
      await vi.waitFor(async () => {
        await expect(svc.refreshAll()).resolves.toBe(true);
        expect(a.refreshDevices).toHaveBeenCalledTimes(3);
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("startAll moves on when a start never settles", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const svc = await makeService();
    vi.useFakeTimers();
    const a = makeRefreshBridge("a");
    const b = makeRefreshBridge("b");
    a.start.mockImplementationOnce(never);
    svc.bridges.push(a as unknown as Bridge, b as unknown as Bridge);

    let done = false;
    const all = svc.startAll().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await all;
    expect(b.start).toHaveBeenCalledTimes(1);
  });
});
