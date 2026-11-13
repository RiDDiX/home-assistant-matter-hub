import type { BridgeData } from "@home-assistant-matter-hub/common";
import { describe, expect, it, vi } from "vitest";
import type { BridgeStorage } from "../storage/bridge-storage.js";
import type { BridgeFactory } from "./bridge-factory.js";
import { BridgeService, type BridgeServiceProps } from "./bridge-service.js";

function storedBridge(id: string, port: number): BridgeData {
  return {
    id,
    name: id,
    port,
    basicInformation: { hardwareVersion: 1, softwareVersion: 1 },
  } as unknown as BridgeData;
}

function makeService(stored: BridgeData[], factory: BridgeFactory) {
  const svc = new BridgeService(
    {
      bridges: stored,
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as BridgeStorage,
    factory,
    {
      basicInformation: {},
      autoRecovery: false,
    } as unknown as BridgeServiceProps,
  );
  return svc.construction.then(() => svc);
}

function fakeBridge(data: BridgeData) {
  return {
    id: data.id,
    data,
    onStatusChange: undefined,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 10))),
    delete: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe("BridgeService delete", () => {
  it("two overlapping deletes of one bridge leave the others in place", async () => {
    const created: ReturnType<typeof fakeBridge>[] = [];
    const factory = {
      create: vi.fn(async (data: BridgeData) => {
        const bridge = fakeBridge(data);
        created.push(bridge);
        return bridge;
      }),
    } as unknown as BridgeFactory;
    const svc = await makeService(
      [
        storedBridge("a", 5540),
        storedBridge("b", 5541),
        storedBridge("c", 5542),
      ],
      factory,
    );

    await Promise.all([svc.delete("a"), svc.delete("a")]);

    expect(svc.bridges.map((b) => b.id)).toEqual(["b", "c"]);
    expect(created[0].delete).toHaveBeenCalledTimes(1);
  });

  it("removes a stored bridge that failed to load and frees its port", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const factory = {
      create: vi.fn(async (data: BridgeData) => {
        if (data.id === "a") throw new Error("broken");
        return fakeBridge(data);
      }),
    } as unknown as BridgeFactory;
    const svc = new BridgeService(
      {
        bridges: [storedBridge("a", 5540), storedBridge("b", 5541)],
        add: vi.fn().mockResolvedValue(undefined),
        remove,
      } as unknown as BridgeStorage,
      factory,
      {
        basicInformation: {},
        autoRecovery: false,
      } as unknown as BridgeServiceProps,
    );
    await svc.construction;
    expect(svc.getNextAvailablePort()).toBe(5542);

    await svc.delete("a");

    expect(remove).toHaveBeenCalledWith("a");
    expect(svc.getNextAvailablePort()).toBe(5540);
  });
});

describe("BridgeService initialize", () => {
  it("loads the other stored bridges when one fails to construct", async () => {
    const factory = {
      create: vi.fn(async (data: BridgeData) => {
        if (data.id === "b") throw new Error("countryCode too long");
        return fakeBridge(data);
      }),
    } as unknown as BridgeFactory;
    const svc = await makeService(
      [
        storedBridge("a", 5540),
        storedBridge("b", 5541),
        storedBridge("c", 5542),
      ],
      factory,
    );

    expect(svc.bridges.map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("drops a stored country code that is not two letters", async () => {
    const factory = {
      create: vi.fn(async (data: BridgeData) => fakeBridge(data)),
    } as unknown as BridgeFactory;
    const svc = await makeService(
      [
        { ...storedBridge("a", 5540), countryCode: "USA" },
        { ...storedBridge("b", 5541), countryCode: "DE" },
      ],
      factory,
    );

    expect(svc.get("a")?.data).not.toHaveProperty("countryCode");
    expect(svc.get("b")?.data.countryCode).toBe("DE");
  });
});
