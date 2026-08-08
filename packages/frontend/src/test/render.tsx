import { ThemeProvider } from "@mui/material/styles";
import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { Provider as StateProvider } from "react-redux";
import { MemoryRouter } from "react-router";
import { store } from "../state/store.ts";
import { appTheme } from "../theme/theme.ts";

function AllProviders({ children }: { children: React.ReactNode }) {
  return (
    <StateProvider store={store}>
      <ThemeProvider theme={appTheme}>
        <MemoryRouter>{children}</MemoryRouter>
      </ThemeProvider>
    </StateProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}
