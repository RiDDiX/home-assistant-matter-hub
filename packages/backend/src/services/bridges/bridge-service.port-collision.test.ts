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

// The factory echoes back the data it was built with, so each bridge's
// final port is readable via svc.get(id).data.port.
function makeFactory(broken?: string): BridgeFactory {
  return {
    create: vi.fn(async (data: BridgeData) => {
      if (data.id === broken) throw new Error("broken");
      return {
        id: data.id,
        data,
        onStatusChange: undefined,
        start: vi.fn().mockResolvedValue(undefined),
      };
    }),
  } as unknown as BridgeFactory;
}

function makeService(
  stored: BridgeData[],
  add = vi.fn(),
  broken?: string,
): Promise<BridgeService> {
  const svc = new BridgeService(
    { bridges: stored, add } as unknown as BridgeStorage,
    makeFactory(broken),
    {
      basicInformation: {},
      autoRecovery: false,
    } as unknown as BridgeServiceProps,
  );
  return svc.construction.then(() => svc);
}

describe("BridgeService stored port collision", () => {
  it("moves a second stored bridge off a port already taken and persists it", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const svc = await makeService(
      [storedBridge("a", 5540), storedBridge("c", 5540)],
      add,
    );

    expect(svc.get("a")?.data.port).toBe(5540);
    expect(svc.get("c")?.data.port).toBe(5541);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c", port: 5541 }),
    );
  });

  it("keeps the port of a stored bridge that failed to load", async () => {
    const svc = await makeService(
      [storedBridge("a", 5540), storedBridge("b", 5541)],
      vi.fn(),
      "a",
    );

    expect(svc.get("a")).toBeUndefined();
    expect(svc.getNextAvailablePort()).toBe(5542);
  });

  it("leaves distinct ports untouched", async () => {
    const svc = await makeService([
      storedBridge("a", 5540),
      storedBridge("b", 5541),
    ]);

    expect(svc.get("a")?.data.port).toBe(5540);
    expect(svc.get("b")?.data.port).toBe(5541);
  });
});
