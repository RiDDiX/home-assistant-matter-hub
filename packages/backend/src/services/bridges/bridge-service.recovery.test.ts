import { describe, expect, it, vi } from "vitest";
import type { BridgeStorage } from "../storage/bridge-storage.js";
import type { Bridge } from "./bridge.js";
import type { BridgeFactory } from "./bridge-factory.js";
import { BridgeService, type BridgeServiceProps } from "./bridge-service.js";

function makeBridge(id: string, status: string) {
  return {
    id,
    data: { status, name: id },
    start: vi.fn().mockResolvedValue(undefined),
  };
}

// autoRecovery off keeps initialize() from starting a timer the tests would leak.
async function makeService(): Promise<BridgeService> {
  const svc = new BridgeService(
    { bridges: [], add: vi.fn() } as unknown as BridgeStorage,
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
