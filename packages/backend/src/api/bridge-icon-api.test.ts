import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import { bridgeIconApi } from "./bridge-icon-api.js";

// Multer diskStorage upload, device-image-api.test.ts covers the sibling: an
// oversized upload must not leave a file behind.

const dir = mkdtempSync(join(tmpdir(), "hamh-bridge-icon-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const iconsDir = join(dir, "bridge-icons");

async function withRouter(fn: (base: string) => Promise<void>, storage = dir) {
  const app = express();
  app.use("/icons", bridgeIconApi(storage));
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function upload(
  base: string,
  bridgeId: string,
  size: number,
  name = "icon.png",
) {
  const form = new FormData();
  form.append("icon", new Blob([Buffer.alloc(size, 1)]), name);
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

  it("replaces an icon with another extension, not one of a prefix id", async () => {
    await withRouter(async (base) => {
      await upload(base, "b3", 16);
      await upload(base, "b30", 16);
      await upload(base, "b3", 16, "icon.jpg");
      const icons = () =>
        readdirSync(iconsDir)
          .filter((f) => f.startsWith("b3"))
          .sort();
      expect(icons()).toEqual(["b3.jpg", "b30.png"]);

      const res = await fetch(`${base}/icons/b3`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(icons()).toEqual(["b30.png"]);
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

  it.each(["..%2fx", "..%2f..%2fx"])("refuses %s", async (bridgeId) => {
    await withRouter(async (base) => {
      const res = await upload(base, bridgeId, 16);
      expect(res.status).toBe(400);
      expect(readdirSync(dir)).toEqual(["bridge-icons"]);
      expect(readdirSync(join(dir, ".."))).not.toContain("x.png");
      expect(readdirSync(join(dir, "..", ".."))).not.toContain("x.png");
    });
  });

  it("refuses a disallowed extension with JSON, not a stack trace", async () => {
    await withRouter(async (base) => {
      const res = await upload(base, "b4", 16, "icon.html");
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = await res.text();
      expect(JSON.parse(body).error).toMatch(/Invalid file type/);
      expect(body).not.toMatch(/ at |node_modules/);
      expect(readdirSync(iconsDir).filter((f) => f.startsWith("b4"))).toEqual(
        [],
      );
    });
  });

  it("answers a disk failure with 500 and no path", async () => {
    const broken = mkdtempSync(join(tmpdir(), "hamh-bridge-icon-"));
    try {
      await withRouter(async (base) => {
        // a file where the icons dir was: ENOTDIR even as root
        rmSync(join(broken, "bridge-icons"), { recursive: true });
        writeFileSync(join(broken, "bridge-icons"), "");
        const res = await upload(base, "b6", 16);
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(JSON.parse(body)).toEqual({ error: "Upload failed" });
        expect(body).not.toContain(broken);
      }, broken);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("refuses an over-long bridge id", async () => {
    await withRouter(async (base) => {
      const res = await upload(base, "a".repeat(300), 16);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid bridge id" });
    });
  });

  it("serves an svg sandboxed and without sniffing", async () => {
    await withRouter(async (base) => {
      await upload(base, "b5", 16, "icon.svg");
      const res = await fetch(`${base}/icons/b5`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });

  it.each([
    "0123456789abcdef0123456789abcdef",
    "01234567-89ab-cdef-0123-456789abcdef",
  ])("uploads, gets and deletes %s", async (bridgeId) => {
    await withRouter(async (base) => {
      expect((await upload(base, bridgeId, 16)).status).toBe(200);
      expect((await fetch(`${base}/icons/${bridgeId}`)).status).toBe(200);
      const res = await fetch(`${base}/icons/${bridgeId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(readdirSync(iconsDir)).not.toContain(`${bridgeId}.png`);
    });
  });
});
