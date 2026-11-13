import {
  type BridgeDataWithMetadata,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridgesApi from "../../api/bridges.ts";
import { setBridgesFromWebSocket } from "../../state/bridges/bridge-actions.ts";
import { store } from "../../state/store.ts";
import { renderWithProviders } from "../../test/render.tsx";
import { AreaBridgeSetupPage } from "./AreaBridgeSetupPage.tsx";

const notify = vi.hoisted(() => ({ show: vi.fn() }));

vi.mock("../../api/bridges.ts");
vi.mock("../../components/notifications/use-notifications.ts", () => ({
  useNotifications: () => notify,
}));
vi.mock("../../routes.tsx", () => ({
  navigation: { bridges: "/bridges", areaSetup: "/bridges/area-setup" },
}));
// the svgr brand icons do not load under vitest
vi.mock("../../components/bridge/ControllerIcon.tsx", () => ({
  ControllerIcon: () => null,
}));

const areas = [
  { area_id: "kitchen", name: "Kitchen", entityCount: 2, domains: {} },
  { area_id: "office", name: "Office", entityCount: 1, domains: {} },
];

const areaBridge = (areaId: string) =>
  ({
    id: areaId,
    name: areaId,
    port: 5540,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Area, value: areaId }],
      exclude: [],
    },
  }) as unknown as BridgeDataWithMetadata;

async function renderPage(bridges: BridgeDataWithMetadata[]) {
  act(() => {
    store.dispatch(setBridgesFromWebSocket(bridges));
  });
  vi.mocked(bridgesApi.fetchBridges).mockResolvedValue(bridges);
  renderWithProviders(<AreaBridgeSetupPage />);
  await screen.findByText("Kitchen");
  fireEvent.click(screen.getByRole("button", { name: "All" }));
}

// Full page render, past 5 s under full suite load.
describe("AreaBridgeSetupPage", { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(areas),
      })),
    );
    vi.mocked(bridgesApi.createBridge).mockResolvedValue(
      {} as BridgeDataWithMetadata,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("skips areas that already have a bridge for that area", async () => {
    await renderPage([areaBridge("kitchen")]);
    fireEvent.click(screen.getByRole("button", { name: "Create 2 Bridges" }));

    expect(
      await screen.findByText(/Already has a bridge, skipped/),
    ).toBeInTheDocument();
    expect(bridgesApi.createBridge).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(bridgesApi.createBridge).mock.calls[0][0].filter.include,
    ).toEqual([{ type: HomeAssistantMatcherType.Area, value: "office" }]);
  });

  it("reports skipped instead of 0 created when every area has a bridge", async () => {
    await renderPage([areaBridge("kitchen"), areaBridge("office")]);
    fireEvent.click(screen.getByRole("button", { name: "Create 2 Bridges" }));

    await waitFor(() =>
      expect(notify.show).toHaveBeenCalledWith({
        message: "Already has a bridge, skipped",
        severity: "info",
      }),
    );
    expect(notify.show).toHaveBeenCalledTimes(1);
    expect(bridgesApi.createBridge).not.toHaveBeenCalled();
  });

  it("deselects the created areas so a second click creates nothing", async () => {
    await renderPage([]);
    fireEvent.click(screen.getByRole("button", { name: "Create 2 Bridges" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Create 0/ })).toBeDisabled(),
    );
    expect(bridgesApi.createBridge).toHaveBeenCalledTimes(2);
  });
});
