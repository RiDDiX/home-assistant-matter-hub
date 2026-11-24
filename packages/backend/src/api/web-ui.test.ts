import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BetterLogger } from "../core/app/logger.js";
import { supportProxyPrefix } from "./proxy-support.js";
import { webUi } from "./web-ui.js";

const dist = mkdtempSync(join(tmpdir(), "hamh-web-ui-"));
afterAll(() => rmSync(dist, { recursive: true, force: true }));
writeFileSync(join(dist, "index.html"), "<!-- BASE --><!-- /BASE -->");

describe("webUi", () => {
  it.each([
    "x-forwarded-prefix",
    "x-ingress-path",
  ])("takes the base href from %s and refuses markup in it", async (header) => {
    const log = { warn: vi.fn() } as never as BetterLogger;
    const app = express().use(supportProxyPrefix(log), webUi(dist));
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { [header]: "/api/hassio_ingress/abc" },
      });
      expect(await res.text()).toBe("<base href='/api/hassio_ingress/abc/' />");
      const hostile = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { [header]: "/a'><script>" },
      });
      expect(hostile.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("escapes the base href taken from the mount path", async () => {
    const app = express().use("/a'b", webUi(dist));
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/a'b/`);
      expect(await res.text()).toBe("<base href='/a&#39;b/' />");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
