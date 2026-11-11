import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/render.tsx";
import { LogViewer } from "./LogViewer.tsx";

const answer = (message: string) => ({
  ok: true,
  json: async () => ({
    entries: [{ timestamp: "2026-11-11T09:00:00Z", level: "info", message }],
  }),
});

describe("LogViewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the newer result when an older request answers last", async () => {
    const pending: Array<(value: unknown) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => pending.push(resolve))),
    );

    renderWithProviders(<LogViewer open onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Search logs..."), {
      target: { value: "newer" },
    });
    expect(pending).toHaveLength(2);

    await act(async () => pending[1](answer("newer entry")));
    await act(async () => pending[0](answer("older entry")));

    expect(screen.getByText("newer entry")).toBeInTheDocument();
    expect(screen.queryByText("older entry")).not.toBeInTheDocument();
  });

  it("keeps a slow answer when a poll for the same filter starts", async () => {
    vi.useFakeTimers();
    try {
      const pending: Array<(value: unknown) => void> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise((resolve) => pending.push(resolve))),
      );

      renderWithProviders(<LogViewer open onClose={() => {}} />);
      act(() => vi.advanceTimersByTime(5000));
      expect(pending).toHaveLength(2);

      await act(async () => pending[0](answer("slow entry")));

      expect(screen.getByText("slow entry")).toBeInTheDocument();
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
