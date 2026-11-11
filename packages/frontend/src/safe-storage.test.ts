import { afterEach, describe, expect, it, vi } from "vitest";
import { safeStorage } from "./safe-storage.ts";

describe("safeStorage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("reads and writes through to localStorage", () => {
    safeStorage.set("k", "v");
    expect(safeStorage.get("k")).toBe("v");
    safeStorage.remove("k");
    expect(safeStorage.get("k")).toBeNull();
  });

  it("swallows storage errors", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);

    expect(safeStorage.get("k")).toBeNull();
    expect(() => safeStorage.set("k", "v")).not.toThrow();
    expect(() => safeStorage.remove("k")).not.toThrow();
  });
});
