import {
  type BridgeDataWithMetadata,
  BridgeStatus,
} from "@home-assistant-matter-hub/common";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchBridges } from "../../api/bridges.ts";
import { fetchDevices } from "../../api/devices.ts";
import { updateBridgeFromWebSocket } from "../../state/bridges/bridge-actions.ts";
import { store } from "../../state/store.ts";
import { renderWithProviders } from "../../test/render.tsx";
import { DevicesPage } from "./DevicesPage.tsx";

vi.mock("../../api/bridges.ts");
vi.mock("../../api/devices.ts");

const bridge = {
  id: "b1",
  name: "Living Room",
  status: BridgeStatus.Running,
  deviceCount: 3,
} as BridgeDataWithMetadata;

describe("DevicesPage", () => {
  it("reloads a bridge's devices only when its status changes", async () => {
    vi.mocked(fetchBridges).mockResolvedValue([bridge]);
    vi.mocked(fetchDevices).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<DevicesPage />);
    await waitFor(() => expect(fetchDevices).toHaveBeenCalledTimes(1));

    act(() => {
      store.dispatch(updateBridgeFromWebSocket({ ...bridge, name: "Den" }));
    });
    expect(fetchDevices).toHaveBeenCalledTimes(1);

    act(() => {
      store.dispatch(
        updateBridgeFromWebSocket({ ...bridge, status: BridgeStatus.Starting }),
      );
    });
    expect(fetchDevices).toHaveBeenCalledTimes(2);
  });
});
