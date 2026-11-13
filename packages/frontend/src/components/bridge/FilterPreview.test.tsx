import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/render.tsx";
import { FilterPreview } from "./FilterPreview.tsx";

const filter = (value: string) => ({
  include: [{ type: "pattern", value }],
  exclude: [],
});

const answer = (total: number) => ({
  ok: true,
  text: async () =>
    JSON.stringify({ total, domains: {}, entities: [], truncated: false }),
});

describe("FilterPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the newer result when an older request answers last", async () => {
    const pending: Array<(value: unknown) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => pending.push(resolve))),
    );

    const { rerender } = renderWithProviders(
      <FilterPreview filter={filter("light.*")} />,
    );
    act(() => vi.advanceTimersByTime(800));
    rerender(<FilterPreview filter={filter("switch.*")} />);
    act(() => vi.advanceTimersByTime(800));
    expect(pending).toHaveLength(2);

    await act(async () => pending[1](answer(2)));
    await act(async () => pending[0](answer(1)));

    expect(screen.getByText("2 entities match")).toBeInTheDocument();
    expect(screen.queryByText("1 entity matches")).not.toBeInTheDocument();
  });
});
