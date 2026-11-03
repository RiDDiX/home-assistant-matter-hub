import type { EndpointData } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { loadDevices } from "./device-actions.ts";
import { devicesPerBridgeReducer } from "./device-reducer.ts";

const tree: EndpointData = {
  id: { global: "root", local: "root" },
  type: { name: "RootNode", id: "0x0016" },
  endpoint: 0,
  state: {},
  parts: [],
};

describe("devicesPerBridgeReducer", () => {
  it("keeps the last good devices when a poll fails", () => {
    const loaded = devicesPerBridgeReducer(
      undefined,
      loadDevices.fulfilled(tree, "req-1", "bridge"),
    );
    const failed = devicesPerBridgeReducer(
      loaded,
      loadDevices.rejected(new Error("502"), "req-2", "bridge"),
    );

    expect(failed.content).toEqual(tree);
    expect(failed.error?.message).toBe("502");
    expect(failed.isLoading).toBe(false);
  });
});
