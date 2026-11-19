import { describe, expect, it, vi } from "vitest";
import type { BridgeStorage } from "../storage/bridge-storage.js";
import type { Bridge } from "./bridge.js";
import type { BridgeFactory } from "./bridge-factory.js";
import { BridgeService, type BridgeServiceProps } from "./bridge-service.js";

function makeBridge(id: string) {
  const bridge = {
    id,
    data: { id, status: "stopped" },
    start: vi.fn(async () => {
      bridge.data.status = "running";
    }),
    stop: vi.fn(async () => {
      bridge.data.status = "stopped";
    }),
  };
  return bridge;
}

describe("BridgeService startAll", () => {
  it("stopAll during startAll leaves later bridges unstarted", async () => {
    const svc = new BridgeService(
      {
        bridges: [],
        add: vi.fn(),
        remove: vi.fn(),
      } as unknown as BridgeStorage,
      {} as unknown as BridgeFactory,
      {
        basicInformation: {},
        autoRecovery: false,
      } as unknown as BridgeServiceProps,
    );
    await svc.construction;
    let release!: () => void;
    const first = makeBridge("a");
    first.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const second = makeBridge("b");
    const third = makeBridge("c");
    svc.bridges.push(...([first, second, third] as unknown as Bridge[]));

    const starting = svc.startAll();
    await vi.waitFor(() => expect(first.start).toHaveBeenCalledTimes(1));
    await svc.stopAll();
    release();
    await starting;

    expect(second.start).not.toHaveBeenCalled();
    expect(third.start).not.toHaveBeenCalled();
  });
});
