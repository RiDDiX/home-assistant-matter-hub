import type { EndpointData } from "@home-assistant-matter-hub/common";
import { ThemeProvider } from "@mui/material/styles";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { appTheme } from "../../theme/theme.ts";
import { EndpointIcon } from "./EndpointIcon.tsx";

function renderInTheme(ui: React.ReactElement) {
  return render(<ThemeProvider theme={appTheme}>{ui}</ThemeProvider>);
}

function makeEndpoint(name: string, id = 1): EndpointData {
  return {
    type: { name, id },
    parts: [],
    id: "test",
  } as unknown as EndpointData;
}

describe("EndpointIcon", () => {
  it.each([
    ["OnOffPlugInUnit"],
    ["DimmableLight"],
    ["ExtendedColorLight"],
    ["Thermostat"],
    ["Fan"],
    ["DoorLock"],
    ["RoboticVacuumCleaner"],
    ["WindowCovering"],
    ["Speaker"],
  ])("renders an icon for %s without crashing", (typeName) => {
    const { container } = renderInTheme(
      <EndpointIcon endpoint={makeEndpoint(typeName)} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders unknown icon for unrecognized types", () => {
    const { container } = renderInTheme(
      <EndpointIcon endpoint={makeEndpoint("SomeNewDevice")} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
