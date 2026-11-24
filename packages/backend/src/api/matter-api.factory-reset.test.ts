import type { AddressInfo } from "node:net";
import { BridgeStatus } from "@home-assistant-matter-hub/common";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { Bridge } from "../services/bridges/bridge.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { EntityIdentityStorage } from "../services/storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import { matterApi } from "./matter-api.js";

async function post(bridge: object, deleteBridgeIdentities = vi.fn()) {
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
    return res.status;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

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
  const code = await post(bridge, deleteBridgeIdentities);
  return { status: code, bridge, deleteBridgeIdentities };
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

  it("leaves a bridge down that was stopped during the reset", async () => {
    const bridge = resettable(async (b) => {
      // the user presses stop while the erase is still running
      await new Promise((r) => setTimeout(r, 50));
      await b.stop();
    });

    expect(await post(bridge)).toBe(200);

    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.status.code).toBe(BridgeStatus.Stopped);
  });

  it("keeps the identities and fails the bridge when the erase throws", async () => {
    const bridge = resettable(async () => {
      throw new Error("erase failed");
    });
    const deleteBridgeIdentities = vi.fn();

    expect(await post(bridge, deleteBridgeIdentities)).toBe(500);

    expect(deleteBridgeIdentities).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.status.code).toBe(BridgeStatus.Failed);
  });
});

// prototype fake as in bridge.factory-reset.test.ts
function resettable(factoryReset: (bridge: Bridge) => Promise<void>) {
  const bridge = Object.create(Bridge.prototype);
  const noop = async () => {};
  Object.assign(bridge, {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    status: { code: BridgeStatus.Running },
    sessions: { stop() {}, start() {}, closeActiveSessions: noop },
    endpointManager: {
      root: { parts: [] },
      failedEntities: [],
      stopPlugins: noop,
      stopObserving() {},
    },
    dataProvider: {
      id: "b1",
      name: "b",
      withMetadata: (status: { code: BridgeStatus }) => ({
        id: "b1",
        status: status.code,
      }),
    },
    server: { cancel: noop, factoryReset: () => factoryReset(bridge) },
  });
  bridge.start = vi.fn(async () => {
    bridge.status = { code: BridgeStatus.Running };
  });
  return bridge;
}

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
