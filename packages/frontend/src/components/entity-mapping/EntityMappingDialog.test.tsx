import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/render.tsx";
import { EntityMappingDialog } from "./EntityMappingDialog.tsx";

function render(domain: string, currentMapping: EntityMappingConfig) {
  const onSave = vi.fn();
  renderWithProviders(
    <EntityMappingDialog
      open
      entityId={currentMapping.entityId}
      domain={domain}
      currentMapping={currentMapping}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  return onSave;
}

const save = () => screen.getByRole("button", { name: "Save" });

// The first render of the full dialog runs past 5 s under full suite load.
describe("EntityMappingDialog", { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks Save on an invalid vendor id and still clears on empty", async () => {
    const onSave = render("light", {
      entityId: "light.kitchen",
      customVendorId: 0x115f,
    });
    const field = screen.getByRole("textbox", { name: "Custom Vendor ID" });

    fireEvent.change(field, { target: { value: "115F" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(save()).toBeDisabled();

    fireEvent.change(field, { target: { value: "" } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].customVendorId).toBeUndefined();
  });

  it("blocks Save while an area data draft is invalid JSON", () => {
    render("vacuum", {
      entityId: "vacuum.robot",
      customServiceAreas: [{ name: "Kitchen", service: "script.clean" }],
    });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Data (JSON, optional)" }),
      { target: { value: "{bad" } },
    );
    expect(save()).toBeDisabled();
  });

  it("keeps the fan speed tag row mounted while its option is typed", () => {
    render("vacuum", { entityId: "vacuum.robot" });
    fireEvent.click(screen.getByRole("button", { name: "Add Tag Mapping" }));
    const option = screen.getByRole("textbox", {
      name: "HA Option (e.g. Max+)",
    });

    fireEvent.change(option, { target: { value: "T" } });

    // A remount would replace the input and drop the focus mid-word.
    expect(option).toBeInTheDocument();
    expect(option).toHaveValue("T");
  });
});
