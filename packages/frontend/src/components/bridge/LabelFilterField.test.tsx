import { ThemeProvider } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HomeAssistantLabel } from "../../api/labels.ts";
import { appTheme } from "../../theme/theme.ts";
import { LabelFilterField } from "./LabelFilterField.tsx";

function renderInTheme(ui: React.ReactElement) {
  return render(<ThemeProvider theme={appTheme}>{ui}</ThemeProvider>);
}

const labels: HomeAssistantLabel[] = [
  { label_id: "matter", name: "Matter" },
  { label_id: "kitchen", name: "Kitchen" },
];

describe("LabelFilterField", () => {
  it("shows the no-labels callout when the list is empty", () => {
    renderInTheme(
      <LabelFilterField
        labels={[]}
        loading={false}
        value={[]}
        onChange={vi.fn()}
        onSwitchType={vi.fn()}
      />,
    );
    expect(screen.getByText("No labels found")).toBeInTheDocument();
  });

  it("switches the filter type from the callout buttons", async () => {
    const onSwitchType = vi.fn();
    renderInTheme(
      <LabelFilterField
        labels={[]}
        loading={false}
        value={[]}
        onChange={vi.fn()}
        onSwitchType={onSwitchType}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /use domains/i }));
    expect(onSwitchType).toHaveBeenCalledWith("domain");
    await userEvent.click(screen.getByRole("button", { name: /use areas/i }));
    expect(onSwitchType).toHaveBeenCalledWith("area");
  });

  it("toggles a label selection when labels exist", async () => {
    const onChange = vi.fn();
    renderInTheme(
      <LabelFilterField
        labels={labels}
        loading={false}
        value={[]}
        onChange={onChange}
        onSwitchType={vi.fn()}
      />,
    );
    expect(screen.queryByText("No labels found")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Matter"));
    expect(onChange).toHaveBeenCalledWith(["matter"]);
  });
});
