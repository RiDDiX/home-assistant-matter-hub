import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react-dom/test-utils";
import { describe, expect, it, vi } from "vitest";
import StandaloneDevicesPage, {
  DeviceCreationForm,
} from "./StandaloneDevicesPage";

vi.mock("../../api/standalone-devices.ts", async () => {
  const actual = await vi.importActual<any>("../../api/standalone-devices.ts");
  return {
    ...actual,
    getStandaloneDevices: vi.fn(() => Promise.resolve([])),
    createStandaloneDevice: vi.fn(() =>
      Promise.resolve({ id: 1, name: "Test Device", deviceType: "light" }),
    ),
    updateStandaloneDevice: vi.fn(),
    deleteStandaloneDevice: vi.fn(),
  };
});

vi.mock("../../api/home-assistant-entities", async () => {
  return {
    fetchEntityList: vi.fn(() => Promise.resolve([])),
  };
});

describe("StandaloneDevicesPage", () => {
  it("renders device creation form and validates input", async () => {
    render(<StandaloneDevicesPage />);
    const portInput = screen.getByLabelText(/port:/i);
    await userEvent.clear(portInput);
    await userEvent.type(portInput, "1234");
    const deviceTypeSelect = screen.getByLabelText(/device type:/i);
    await userEvent.selectOptions(deviceTypeSelect, "light");
    const entityInput = screen.getByPlaceholderText(/type to search entities/i);
    await userEvent.type(entityInput, "light.living_room");
    await userEvent.keyboard("{Enter}");
    await act(async () => {
      await userEvent.click(screen.getByText(/Create Device/i));
    });
    // Assert error message is rendered using test id
    const errorDiv = await screen.findByTestId("device-form-error");
    expect(errorDiv).toHaveTextContent(/device name is required/i);
  });
});
