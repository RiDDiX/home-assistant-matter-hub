import { ThemeProvider } from "@mui/material/styles";
import type { FieldProps } from "@rjsf/utils";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appTheme } from "../../../theme/theme.ts";
import { EntityFilterRuleField } from "./EntityFilterRuleField.tsx";

function renderInTheme(ui: React.ReactElement) {
  return render(<ThemeProvider theme={appTheme}>{ui}</ThemeProvider>);
}

function makeProps(overrides?: Partial<FieldProps>): FieldProps {
  return {
    schema: {
      type: "object",
      properties: {
        type: {
          title: "Type",
          type: "string",
          oneOf: [
            { const: "pattern", title: "pattern", description: "wildcard" },
            { const: "domain", title: "domain", description: "by domain" },
          ],
        },
        value: { title: "Value", type: "string", description: "the value" },
      },
    },
    formData: { type: "pattern", value: "" },
    onChange: vi.fn(),
    disabled: false,
    readonly: false,
    fieldPathId: { path: "filter.include.0" },
    ...overrides,
  } as unknown as FieldProps;
}

describe("EntityFilterRuleField", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ entities: [] }),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses entity autocomplete for pattern rules", async () => {
    renderInTheme(<EntityFilterRuleField {...makeProps()} />);
    expect(
      await screen.findByRole("combobox", { name: /value/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /value/i }),
    ).not.toBeInTheDocument();
  });

  it("uses a plain text field for non-entity rules", () => {
    renderInTheme(
      <EntityFilterRuleField
        {...makeProps({ formData: { type: "domain", value: "light" } })}
      />,
    );
    expect(screen.getByRole("textbox", { name: /value/i })).toHaveValue(
      "light",
    );
    expect(
      screen.queryByRole("combobox", { name: /value/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the description of the selected type", () => {
    renderInTheme(
      <EntityFilterRuleField
        {...makeProps({ formData: { type: "domain", value: "" } })}
      />,
    );
    expect(screen.getByText("by domain")).toBeInTheDocument();
  });

  it("merges value edits into the rule and reports the field path", async () => {
    const onChange = vi.fn();
    renderInTheme(
      <EntityFilterRuleField
        {...makeProps({ formData: { type: "domain", value: "" }, onChange })}
      />,
    );

    await userEvent.type(screen.getByRole("textbox", { name: /value/i }), "l");

    expect(onChange).toHaveBeenLastCalledWith(
      { type: "domain", value: "l" },
      "filter.include.0",
    );
  });

  it("commits typed text for pattern rules via the autocomplete", async () => {
    const onChange = vi.fn();
    renderInTheme(
      <EntityFilterRuleField
        {...makeProps({ formData: { type: "pattern", value: "" }, onChange })}
      />,
    );

    const input = await screen.findByRole("combobox", { name: /value/i });
    await userEvent.type(input, "switch.dian_juan_men_tuya_l*");

    expect(onChange).toHaveBeenLastCalledWith(
      { type: "pattern", value: "switch.dian_juan_men_tuya_l*" },
      "filter.include.0",
    );
  });
});
