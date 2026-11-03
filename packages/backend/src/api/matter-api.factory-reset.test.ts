import type { AddressInfo } from "node:net";
import { BridgeStatus } from "@home-assistant-matter-hub/common";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { EntityIdentityStorage } from "../services/storage/entity-identity-storage.js";
import { matterApi } from "./matter-api.js";

async function factoryReset(status: BridgeStatus) {
  const bridge = {
    id: "b1",
    data: { id: "b1", status },
    factoryReset: vi.fn().mockResolvedValue(undefined),
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
    expect(bridge.factoryReset).not.toHaveBeenCalled();
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
