import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import {
  createBridge,
  loadBridges,
  updateBridgeFromWebSocket,
} from "./bridge-actions.ts";
import { bridgesReducer } from "./bridges-reducer.ts";

const bridge = {
  id: "b1",
  name: "Living Room",
  port: 5540,
} as BridgeDataWithMetadata;

describe("bridgesReducer", () => {
  it("does not list a created bridge twice after its WebSocket update", () => {
    let state = bridgesReducer(
      undefined,
      loadBridges.fulfilled([], "req-1", undefined),
    );
    state = bridgesReducer(state, updateBridgeFromWebSocket(bridge));
    state = bridgesReducer(
      state,
      createBridge.fulfilled({ ...bridge, name: "Kitchen" }, "req-2", {
        name: "Kitchen",
        filter: { include: [], exclude: [] },
      }),
    );

    expect(state.items.content).toHaveLength(1);
    expect(state.items.content?.[0].name).toBe("Kitchen");
  });

  it("keeps the last good list when a reload fails", () => {
    const loaded = bridgesReducer(
      undefined,
      loadBridges.fulfilled([bridge], "req-1", undefined),
    );
    const failed = bridgesReducer(
      loaded,
      loadBridges.rejected(new Error("502"), "req-2", undefined),
    );

    expect(failed.items.content).toEqual([bridge]);
    expect(failed.items.error?.message).toBe("502");
    expect(failed.items.isLoading).toBe(false);
  });
});
