import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy-text.ts";

function fireCopy(setData: (type: string, value: string) => void) {
  const event = new Event("copy", { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { setData } });
  document.dispatchEvent(event);
  return true;
}

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the async clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("abc")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("falls back to a copy event without a clipboard (plain http)", async () => {
    vi.stubGlobal("navigator", {});
    const setData = vi.fn();
    document.execCommand = vi.fn(() => fireCopy(setData));
    expect(await copyText("abc")).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "abc");
  });

  it("reports failure when the copy event never fires", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    document.execCommand = vi.fn().mockReturnValue(true);
    expect(await copyText("abc")).toBe(false);
  });
});
