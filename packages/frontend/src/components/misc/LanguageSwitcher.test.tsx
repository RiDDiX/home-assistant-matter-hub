import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.ts";
import { renderWithProviders } from "../../test/render.tsx";
import { LanguageSwitcher } from "./LanguageSwitcher.tsx";

describe("LanguageSwitcher", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("opens a menu that lists Polish and closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LanguageSwitcher />);

    await user.click(screen.getByRole("button", { name: /language/i }));

    expect(screen.getByRole("menuitem", { name: "Polski" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "English" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("switches the language and the html lang attribute", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LanguageSwitcher />);

    await user.click(screen.getByRole("button", { name: /language/i }));
    await user.click(screen.getByRole("menuitem", { name: "Polski" }));

    expect(i18n.language).toBe("pl");
    expect(document.documentElement.lang).toBe("pl");
  });
});
