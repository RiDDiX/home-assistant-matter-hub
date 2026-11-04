import type { AddressInfo } from "node:net";
import type { Logger } from "@matter/general";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { accessLogger } from "./access-log.js";

describe("accessLogger", () => {
  it("logs a malformed percent escape without throwing", async () => {
    const debug = vi.fn();
    const app = express();
    app.use(accessLogger({ debug } as unknown as Logger));
    app.get("/x", (_req, res) => {
      res.send("ok");
    });
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/x?%E0%A4%A`);
      expect(res.status).toBe(200);
      await vi.waitFor(() =>
        expect(debug).toHaveBeenCalledWith(
          expect.stringContaining("/x?%E0%A4%A"),
        ),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
