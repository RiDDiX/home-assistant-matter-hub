import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import { supportIngress } from "./proxy-support.js";
import { webUi } from "./web-ui.js";

const dist = mkdtempSync(join(tmpdir(), "hamh-web-ui-"));
afterAll(() => rmSync(dist, { recursive: true, force: true }));
writeFileSync(join(dist, "index.html"), "<!-- BASE --><!-- /BASE -->");

describe("webUi", () => {
  it("escapes the base href taken from the ingress path", async () => {
    const app = express().use(supportIngress, webUi(dist));
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "x-ingress-path": "/a'><script>" },
      });
      expect(await res.text()).toBe(
        "<base href='/a&#39;&gt;&lt;script&gt;/' />",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
