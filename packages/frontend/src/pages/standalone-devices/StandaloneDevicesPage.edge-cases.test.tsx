import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../api/standalone-devices.ts", async () => {
  const actual = await vi.importActual<any>("../../api/standalone-devices.ts");
  return {
    ...actual,
    getStandaloneDevices: vi.fn(() => Promise.resolve([])),
    createStandaloneDevice: vi.fn(() => {
      const error = new Error("Port already in use");
      (error as any).error = "Port already in use";
      throw error;
    }),
    updateStandaloneDevice: vi.fn(),
    deleteStandaloneDevice: vi.fn(),
  };
});

vi.mock("../../api/home-assistant-entities", async () => {
  return {
    fetchEntityList: vi.fn(() => Promise.resolve([])),
  };
});

describe("StandaloneDevicesPage edge cases", () => {
  it("shows error for duplicate port", async () => {
    const { default: StandaloneDevicesPage } = await import(
      "./StandaloneDevicesPage"
    );
    render(<StandaloneDevicesPage />);
    fireEvent.change(screen.getByLabelText(/Name:/i), {
      target: { value: "Test Device" },
    });
    fireEvent.change(screen.getByLabelText(/Port:/i), {
      target: { value: 1234 },
    });
    fireEvent.change(screen.getByLabelText(/Device Type:/i), {
      target: { value: "light" },
    });
    // Add a valid entity to pass entity validation
    fireEvent.change(
      screen.getByPlaceholderText(/Type to search entities.../i),
      { target: { value: "light.living_room" } },
    );
    fireEvent.keyDown(
      screen.getByPlaceholderText(/Type to search entities.../i),
      { key: "Enter", code: "Enter" },
    );
    fireEvent.click(screen.getByText(/Create Device/i));
    await waitFor(() =>
      expect(screen.getByText(/port already in use/i)).toBeInTheDocument(),
    );
  });

  it("shows error for missing device type", async () => {
    const { default: StandaloneDevicesPage } = await import(
      "./StandaloneDevicesPage"
    );
    render(<StandaloneDevicesPage />);
    fireEvent.change(screen.getByLabelText(/Name:/i), {
      target: { value: "Test Device" },
    });
    fireEvent.change(screen.getByLabelText(/Port:/i), {
      target: { value: 1235 },
    });
    // Do not select device type
    fireEvent.click(screen.getByText(/Create Device/i));
    await waitFor(() =>
      expect(screen.getByText(/device type/i)).toBeInTheDocument(),
    );
  });

  it("shows error for invalid entity ID", async () => {
    const { default: StandaloneDevicesPage } = await import(
      "./StandaloneDevicesPage"
    );
    render(<StandaloneDevicesPage />);
    fireEvent.change(screen.getByLabelText(/Name:/i), {
      target: { value: "Test Device" },
    });
    fireEvent.change(screen.getByLabelText(/Port:/i), {
      target: { value: 1236 },
    });
    fireEvent.change(screen.getByLabelText(/Device Type:/i), {
      target: { value: "light" },
    });
    // Simulate entering an invalid entity ID
    fireEvent.change(
      screen.getByPlaceholderText(/Type to search entities.../i),
      { target: { value: "bad id" } },
    );
    fireEvent.keyDown(
      screen.getByPlaceholderText(/Type to search entities.../i),
      { key: "Enter", code: "Enter" },
    );
    fireEvent.click(screen.getByText(/Create Device/i));
    await waitFor(() =>
      expect(
        screen.getByText(/at least one entity is required/i),
      ).toBeInTheDocument(),
    );
  });
});
