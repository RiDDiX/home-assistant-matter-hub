import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { BridgeStorage } from "../services/storage/bridge-storage.js";
import { bridgeExportApi } from "./bridge-export-api.js";

const exported = (bridges: object[]) => ({
  version: 1,
  exportedAt: "2026-11-01T00:00:00Z",
  bridges,
});

const bridge = (id: string, extra = {}) => ({
  id,
  name: id,
  port: 5550,
  filter: { include: [], exclude: [] },
  ...extra,
});

async function importBridges(
  data: object,
  bridgeIds: string[],
  stored: object[] = [],
) {
  const importBridge = vi.fn().mockResolvedValue(undefined);
  const add = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    "/bridges",
    bridgeExportApi(
      { bridges: stored, add } as unknown as BridgeStorage,
      { importBridge } as unknown as BridgeService,
    ),
  );
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/bridges/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data,
        options: { bridgeIds, overwriteExisting: true },
      }),
    });
    return { result: await res.json(), importBridge, add };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /bridges/import", () => {
  it("applies imported bridges through the bridge service", async () => {
    const { result, importBridge, add } = await importBridges(
      exported([bridge("b1", { uniqueIdSuffix: "u1" }), bridge("b2")]),
      ["b1"],
    );

    expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(importBridge).toHaveBeenCalledTimes(1);
    expect(importBridge).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b1", uniqueIdSuffix: "u1" }),
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("reports an invalid bridge instead of applying it", async () => {
    const { result, importBridge } = await importBridges(
      exported([bridge("b1", { port: "nope" })]),
      ["b1"],
    );

    expect(result.imported).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({ bridgeId: "b1" }),
    ]);
    expect(importBridge).not.toHaveBeenCalled();
  });
});
