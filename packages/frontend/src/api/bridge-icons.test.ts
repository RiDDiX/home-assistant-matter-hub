import { afterEach, describe, expect, it, vi } from "vitest";
import { checkBridgeIconExists } from "./bridge-icons.ts";

describe("checkBridgeIconExists", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves false when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to parse URL");
      }),
    );
    await expect(checkBridgeIconExists("b1")).resolves.toBe(false);
  });

  it("resolves the exists flag from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ exists: true }))),
    );
    await expect(checkBridgeIconExists("b1")).resolves.toBe(true);
  });
});
