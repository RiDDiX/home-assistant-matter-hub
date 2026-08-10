import { ThemeProvider } from "@mui/material/styles";
import type { FieldProps } from "@rjsf/utils";
import { fireEvent, render, screen } from "@testing-library/react";
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

// #443: number-typed flags (coverSliderDebounceMs, fanSliderDebounceMs) used to
// render as boolean switches, so the form wrote true/false and schema
// validation rejected the config.
describe("FeatureFlagsField number flags", () => {
  function makeNumberProps(overrides?: Partial<FieldProps>): FieldProps {
    return makeProps({
      schema: {
        type: "object",
        properties: {
          coverSliderDebounceMs: {
            type: "number",
            title: "Cover Slider Debounce (ms)",
            description: "Debounce window for cover position updates",
            minimum: 0,
            maximum: 5000,
            default: 0,
          },
          fanSliderDebounceMs: {
            type: "number",
            title: "Fan Slider Debounce (ms)",
            description: "Debounce window for fan speed writes",
            minimum: 0,
            maximum: 10000,
            default: 0,
          },
          serverMode: {
            type: "boolean",
            title: "Server Mode",
            description: "Expose as standalone device",
            default: false,
          },
        },
      },
      ...overrides,
    });
  }

  it("renders number flags as number inputs, booleans keep the switch", () => {
    const { container } = renderInTheme(
      <FeatureFlagsField {...makeNumberProps()} />,
    );

    expect(
      screen.getByLabelText("Cover Slider Debounce (ms)"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Fan Slider Debounce (ms)"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      1,
    );
  });

  it("writes a number, never a boolean", () => {
    const onChange = vi.fn();
    renderInTheme(<FeatureFlagsField {...makeNumberProps({ onChange })} />);

    fireEvent.change(screen.getByLabelText("Cover Slider Debounce (ms)"), {
      target: { value: "1200" },
    });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).toEqual({ coverSliderDebounceMs: 1200 });

    fireEvent.change(screen.getByLabelText("Fan Slider Debounce (ms)"), {
      target: { value: "1500" },
    });
    expect(onChange.mock.calls[1][0]).toEqual({ fanSliderDebounceMs: 1500 });
  });

  it("clearing the input removes the flag instead of writing a boolean", () => {
    const onChange = vi.fn();
    renderInTheme(
      <FeatureFlagsField
        {...makeNumberProps({
          onChange,
          formData: { fanSliderDebounceMs: 500 },
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText("Fan Slider Debounce (ms)"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).toEqual({});
  });
});
