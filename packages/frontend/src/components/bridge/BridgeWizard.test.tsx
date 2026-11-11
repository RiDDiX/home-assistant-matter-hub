import {
  bridgeTemplates,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridgesApi from "../../api/bridges.ts";
import { renderWithProviders } from "../../test/render.tsx";
import { BridgeWizard } from "./BridgeWizard.tsx";

vi.mock("../../api/bridges.ts");
// the svgr brand icons do not load under vitest
vi.mock("./ControllerIcon.tsx", () => ({ ControllerIcon: () => null }));

const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

function enterName() {
  fireEvent.change(screen.getByRole("textbox", { name: "Bridge Name" }), {
    target: { value: "Test" },
  });
}

async function created() {
  click("Create Bridge");
  await waitFor(() => expect(bridgesApi.createBridge).toHaveBeenCalled());
  return vi.mocked(bridgesApi.createBridge).mock.calls[0][0];
}

// Multi-step dialog flow, past 5 s under full suite load.
describe("BridgeWizard", { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function render() {
    renderWithProviders(
      <BridgeWizard open onClose={vi.fn()} onComplete={vi.fn()} />,
    );
  }

  function toReview() {
    enterName();
    click("Next");
    click("Next");
    click("Next");
  }

  it("drops a controller profile's flags when it is deselected", async () => {
    render();
    click("Skip Template");
    click(/^Amazon Alexa/);
    click(/^Amazon Alexa/);
    click("Skip");
    toReview();

    expect(screen.queryByText("Auto Force Sync")).not.toBeInTheDocument();
    expect((await created()).featureFlags).toBeUndefined();
  });

  it("replaces the old profile's flags when switching profiles", async () => {
    render();
    click("Skip Template");
    click(/^Amazon Alexa/);
    click(/^Apple Home/);
    click("Next");
    toReview();

    const flags = (await created()).featureFlags;
    expect(flags?.autoComposedDevices).toBe(true);
    expect(flags?.autoForceSync).toBeUndefined();
    expect(flags?.coverUseHomeAssistantPercentage).toBeUndefined();
  });

  it("resets a domain filter when the template is deselected", async () => {
    const template = bridgeTemplates.find((t) => !t.featureFlags?.serverMode);
    if (!template) throw new Error("no bridged template");
    render();
    click("Skip Template");
    click("Skip");
    enterName();
    click("Next");
    click("Domain");
    click("Back");
    click("Back");
    click("Back");
    fireEvent.click(screen.getByText(template.name));
    fireEvent.click(screen.getByText(template.name));
    click("Skip Template");
    click("Skip");
    toReview();

    expect((await created()).filter.include).toEqual([
      { type: HomeAssistantMatcherType.Pattern, value: "*" },
    ]);
  });
});
