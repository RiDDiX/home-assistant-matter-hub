import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import { bridgeIconApi } from "./bridge-icon-api.js";

// The only multer diskStorage routes with a test: upload, and an oversized
// upload must not leave a file behind.

const dir = mkdtempSync(join(tmpdir(), "hamh-bridge-icon-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const iconsDir = join(dir, "bridge-icons");

async function withRouter(fn: (base: string) => Promise<void>) {
  const app = express();
  app.use("/icons", bridgeIconApi(dir));
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function upload(base: string, bridgeId: string, size: number) {
  const form = new FormData();
  form.append("icon", new Blob([Buffer.alloc(size, 1)]), "icon.png");
  return fetch(`${base}/icons/${bridgeId}`, { method: "POST", body: form });
}

describe("bridge icon upload", () => {
  it("stores the uploaded file", async () => {
    await withRouter(async (base) => {
      const res = await upload(base, "b1", 1024);
      expect(res.status).toBe(200);
      expect(readFileSync(join(iconsDir, "b1.png")).length).toBe(1024);
    });
  });

  it("leaves no file behind when the upload is too large", async () => {
    await withRouter(async (base) => {
      const res = await upload(base, "b2", 5 * 1024 * 1024 + 1);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(readdirSync(iconsDir).filter((f) => f.startsWith("b2"))).toEqual(
        [],
      );
    });
  });

  it("refuses a bridge id that climbs out of the icons dir", async () => {
    await withRouter(async (base) => {
      const res = await upload(base, "..%2F..%2Fescaped", 16);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid bridge id" });
      expect(readdirSync(dir)).toEqual(["bridge-icons"]);
      expect(readdirSync(join(dir, ".."))).not.toContain("escaped.png");
    });
  });
});
