import type {
  BridgeData,
  CreateBridgeRequest,
  UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it, vi } from "vitest";
import type { BridgeStorage } from "../storage/bridge-storage.js";
import type { BridgeFactory } from "./bridge-factory.js";
import { BridgeService, type BridgeServiceProps } from "./bridge-service.js";

function bridgeData(id: string, port: number, extra = {}): BridgeData {
  return {
    id,
    name: id,
    port,
    filter: { include: [], exclude: [] },
    basicInformation: { hardwareVersion: 1, softwareVersion: 1 },
    ...extra,
  } as unknown as BridgeData;
}

// Each fake bridge keeps its data and applies updates like the real
// provider would, so the service result is readable via svc.get(id).data.
function makeFactory(): BridgeFactory {
  return {
    create: vi.fn(async (initial: BridgeData) => {
      const bridge = {
        id: initial.id,
        data: initial,
        onStatusChange: undefined,
        start: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(async (request: UpdateBridgeRequest) => {
          bridge.data = { ...bridge.data, ...request };
        }),
      };
      return bridge;
    }),
  } as unknown as BridgeFactory;
}

async function makeService(stored: BridgeData[]) {
  const add = vi.fn().mockResolvedValue(undefined);
  const svc = new BridgeService(
    { bridges: stored, add } as unknown as BridgeStorage,
    makeFactory(),
    {
      basicInformation: {},
      autoRecovery: false,
    } as unknown as BridgeServiceProps,
  );
  await svc.construction;
  add.mockClear();
  const changed = vi.fn();
  svc.onBridgeChanged = changed;
  return { svc, add, changed };
}

describe("BridgeService.importBridge", () => {
  it("adds, stores and starts a new bridge without a restart", async () => {
    const { svc, add, changed } = await makeService([bridgeData("a", 5540)]);

    const bridge = await svc.importBridge(bridgeData("new", 5545));

    expect(svc.get("new")).toBe(bridge);
    expect(bridge.start).toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }));
    expect(changed).toHaveBeenCalledWith("new");
  });

  it("moves a new bridge off a port another bridge uses", async () => {
    const { svc } = await makeService([bridgeData("a", 5540)]);

    await svc.importBridge(bridgeData("new", 5540));

    expect(svc.get("new")?.data.port).toBe(5541);
  });

  it("drops a new bridge whose storage write failed", async () => {
    const { svc, add } = await makeService([]);
    const error = new Error("disk full");
    add.mockRejectedValueOnce(error);

    await expect(svc.importBridge(bridgeData("new", 5545))).rejects.toBe(error);

    expect(svc.get("new")).toBeUndefined();
    const bridge = await svc.importBridge(bridgeData("new", 5545));
    expect(bridge.data.port).toBe(5545);
    expect(svc.bridges).toEqual([bridge]);
  });

  it("overwrites the running bridge with the same id", async () => {
    const { svc, add } = await makeService([
      bridgeData("a", 5540, { name: "Old" }),
    ]);

    const bridge = await svc.importBridge(
      bridgeData("a", 5540, { name: "Imported" }),
    );

    expect(svc.bridges).toHaveLength(1);
    expect(bridge.update).toHaveBeenCalledWith(
      expect.not.objectContaining({ basicInformation: expect.anything() }),
    );
    expect(svc.get("a")?.data.name).toBe("Imported");
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", name: "Imported" }),
    );
  });
});

describe("BridgeService.updatePriorities", () => {
  // Update replaces the optional keys, so the priority call must carry them.
  it("keeps the suffixes and session age of the bridge", async () => {
    const { svc } = await makeService([
      bridgeData("a", 5540, {
        serialNumberSuffix: "s",
        uniqueIdSuffix: "u",
        sessionMaxAgeHours: 4,
      }),
    ]);

    await svc.updatePriorities([{ id: "a", priority: 5 }]);

    expect(svc.get("a")?.update).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 5,
        serialNumberSuffix: "s",
        uniqueIdSuffix: "u",
        sessionMaxAgeHours: 4,
      }),
    );
  });
});

describe("BridgeService.update", () => {
  it("does not store a bridge a delete removed while it updated", async () => {
    const { svc, add } = await makeService([bridgeData("a", 5540)]);
    const bridge = svc.get("a");
    vi.mocked(bridge!.update).mockImplementation(async () => {
      svc.bridges.splice(0, 1);
    });

    await svc.update({ ...bridgeData("a", 5540), name: "late" });

    expect(add).not.toHaveBeenCalled();
  });
});

describe("BridgeService.create", () => {
  const request = {
    name: "x",
    filter: { include: [], exclude: [] },
  } as unknown as CreateBridgeRequest;

  it("gives two creates in flight different free ports", async () => {
    const { svc } = await makeService([]);

    const [a, b] = await Promise.all([
      svc.create(request),
      svc.create(request),
    ]);

    expect(a.data.port).not.toBe(b.data.port);
  });

  it("refuses a second create on the same explicit port", async () => {
    const { svc } = await makeService([]);

    const results = await Promise.allSettled([
      svc.create({ ...request, port: 5600 }),
      svc.create({ ...request, port: 5600 }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(svc.bridges).toHaveLength(1);
  });

  it("drops a bridge whose storage write failed", async () => {
    const { svc, add } = await makeService([]);
    const error = new Error("disk full");
    let failed: (typeof svc.bridges)[number] | undefined;
    add.mockImplementationOnce(async () => {
      failed = svc.bridges[0];
      throw error;
    });

    await expect(svc.create({ ...request, port: 5600 })).rejects.toBe(error);

    expect(svc.bridges).toHaveLength(0);
    expect(failed?.dispose).toHaveBeenCalled();
    const bridge = await svc.create({ ...request, port: 5600 });
    expect(bridge.data.port).toBe(5600);
    expect(svc.bridges).toEqual([bridge]);
  });
});
