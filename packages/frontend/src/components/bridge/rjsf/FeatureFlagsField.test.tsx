import { ThemeProvider } from "@mui/material/styles";
import type { FieldProps } from "@rjsf/utils";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { appTheme } from "../../../theme/theme.ts";
import { FeatureFlagsField } from "./FeatureFlagsField.tsx";

function renderInTheme(ui: React.ReactElement) {
  return render(<ThemeProvider theme={appTheme}>{ui}</ThemeProvider>);
}

function makeProps(overrides?: Partial<FieldProps>): FieldProps {
  return {
    schema: {
      type: "object",
      properties: {
        autoForceSync: {
          type: "boolean",
          title: "Auto Force Sync",
          description: "Periodically push state to controllers",
          default: false,
        },
        serverMode: {
          type: "boolean",
          title: "Server Mode",
          description: "Expose as standalone device",
          default: false,
        },
      },
    },
    formData: {},
    onChange: vi.fn(),
    disabled: false,
    readonly: false,
    fieldPathId: { path: "" },
    ...overrides,
  } as unknown as FieldProps;
}

describe("FeatureFlagsField", () => {
  it("renders all feature flags from schema", () => {
    renderInTheme(<FeatureFlagsField {...makeProps()} />);
    expect(screen.getByText("Auto Force Sync")).toBeInTheDocument();
    expect(screen.getByText("Server Mode")).toBeInTheDocument();
    expect(
      screen.getByText("Periodically push state to controllers"),
    ).toBeInTheDocument();
  });

  it("calls onChange when a flag card is clicked", async () => {
    const onChange = vi.fn();
    renderInTheme(<FeatureFlagsField {...makeProps({ onChange })} />);

    await userEvent.click(screen.getByText("Auto Force Sync"));

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).toEqual({ autoForceSync: true });
  });

  it("shows 'Active' chip when a flag is enabled", () => {
    renderInTheme(
      <FeatureFlagsField
        {...makeProps({ formData: { autoForceSync: true } })}
      />,
    );
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("disables interaction when disabled prop is true", () => {
    const { container } = renderInTheme(
      <FeatureFlagsField {...makeProps({ disabled: true })} />,
    );

    const inputs = container.querySelectorAll('input[type="checkbox"]');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input).toBeDisabled();
    }
  });
});
