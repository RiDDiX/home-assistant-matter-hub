import type { AddressInfo } from "node:net";
import { BridgeStatus } from "@home-assistant-matter-hub/common";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { EntityIdentityStorage } from "../services/storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import { matterApi } from "./matter-api.js";

// runs: what Bridge.factoryReset sees, the bridge can stop after data was read
async function factoryReset(
  status: BridgeStatus,
  runs = status === BridgeStatus.Running,
) {
  const bridge = {
    id: "b1",
    data: { id: "b1", status },
    factoryReset: vi.fn(async (beforeReset?: () => Promise<void>) => {
      if (!runs) return false;
      await beforeReset?.();
      return true;
    }),
    start: vi.fn().mockResolvedValue(undefined),
  };
  const deleteBridgeIdentities = vi.fn().mockResolvedValue(undefined);
  const app = express();
  app.use(express.json());
  app.use(
    "/matter",
    matterApi({ bridges: [bridge] } as unknown as BridgeService, undefined, {
      deleteBridgeIdentities,
    } as unknown as EntityIdentityStorage),
  );
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${port}/matter/bridges/b1/actions/factory-reset`,
      { method: "POST" },
    );
    return { status: res.status, bridge, deleteBridgeIdentities };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /bridges/:id/actions/factory-reset", () => {
  it("refuses a stopped bridge and keeps its identities", async () => {
    const { status, bridge, deleteBridgeIdentities } = await factoryReset(
      BridgeStatus.Stopped,
    );

    expect(status).toBe(409);
    expect(deleteBridgeIdentities).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("keeps the identities of a bridge that stopped before the reset ran", async () => {
    const { status, bridge, deleteBridgeIdentities } = await factoryReset(
      BridgeStatus.Running,
      false,
    );

    expect(status).toBe(409);
    expect(deleteBridgeIdentities).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("resets a running bridge", async () => {
    const { status, bridge, deleteBridgeIdentities } = await factoryReset(
      BridgeStatus.Running,
    );

    expect(status).toBe(200);
    expect(deleteBridgeIdentities).toHaveBeenCalledWith("b1");
    expect(bridge.factoryReset).toHaveBeenCalled();
  });
});

describe("DELETE /bridges/:id", () => {
  // The mapping-only delete route is never called by the UI, so the
  // mappings of a deleted bridge stayed in the store and in every backup.
  it("drops the bridge's identities and mappings", async () => {
    const deleteBridgeIdentities = vi.fn().mockResolvedValue(undefined);
    const deleteBridgeMappings = vi.fn().mockResolvedValue(undefined);
    const app = express();
    app.use(
      "/matter",
      matterApi(
        {
          delete: vi.fn().mockResolvedValue(undefined),
        } as unknown as BridgeService,
        undefined,
        { deleteBridgeIdentities } as unknown as EntityIdentityStorage,
        { deleteBridgeMappings } as unknown as EntityMappingStorage,
      ),
    );
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/matter/bridges/b1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(deleteBridgeIdentities).toHaveBeenCalledWith("b1");
    expect(deleteBridgeMappings).toHaveBeenCalledWith("b1");
  });
});
