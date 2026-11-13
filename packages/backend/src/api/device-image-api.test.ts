import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import { deviceImageApi } from "./device-image-api.js";

const dir = mkdtempSync(join(tmpdir(), "hamh-device-image-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const imagesDir = join(dir, "device-images");
const registry = { entities: {}, devices: {} } as HomeAssistantRegistry;

async function withRouter(fn: (base: string) => Promise<void>, storage = dir) {
  const app = express();
  app.use(express.json());
  app.use("/images", deviceImageApi(storage, registry));
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function form(name: string, size = 16) {
  const form = new FormData();
  form.append("image", new Blob([Buffer.alloc(size, 1)]), name);
  return form;
}

function upload(base: string, entityId: string, name: string, size = 16) {
  return fetch(`${base}/images/${entityId}`, {
    method: "POST",
    body: form(name, size),
  });
}

// fetch resolves "." and ".." segments before sending, http.request does not
async function raw(
  base: string,
  method: string,
  path: string,
  body?: FormData,
) {
  const encoded = new Request(base, { method, body });
  const payload = Buffer.from(await encoded.arrayBuffer());
  const type = encoded.headers.get("content-type");
  const { hostname, port } = new URL(base);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        path,
        method,
        headers: type ? { "content-type": type } : {},
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const images = (prefix: string) =>
  readdirSync(imagesDir).filter((f) => f.startsWith(prefix));

describe("device image upload", () => {
  it("refuses a disallowed extension with JSON", async () => {
    await withRouter(async (base) => {
      const res = await upload(base, "light.a", "image.html");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Invalid file type/);
      expect(images("light.a")).toEqual([]);
    });
  });

  it("serves an svg sandboxed and without sniffing", async () => {
    await withRouter(async (base) => {
      expect((await upload(base, "light.b", "image.svg")).status).toBe(200);
      const res = await fetch(`${base}/images/light.b`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });

  it.each([".", "..", "a".repeat(300)])("refuses the id %s", async (id) => {
    await withRouter(async (base) => {
      const before = readdirSync(imagesDir);
      for (const res of [
        await raw(base, "POST", `/images/${id}`, form("image.png")),
        await raw(base, "GET", `/images/${id}`),
      ]) {
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body)).toEqual({ error: "Invalid entity id" });
      }
      expect(readdirSync(imagesDir)).toEqual(before);
      expect(readdirSync(dir)).toEqual(["device-images"]);
    });
  });

  it("answers an oversized upload with 413 and leaves no file", async () => {
    await withRouter(async (base) => {
      const res = await upload(
        base,
        "light.big",
        "image.png",
        5 * 1024 * 1024 + 1,
      );
      expect(res.status).toBe(413);
      expect((await res.json()).error).toBeTypeOf("string");
      expect(images("light.big")).toEqual([]);
    });
  });

  it("uploads, replaces, serves and deletes one image", async () => {
    await withRouter(async (base) => {
      expect((await upload(base, "light.kitchen", "a.png")).status).toBe(200);
      expect(images("light.kitchen")).toEqual(["light.kitchen.png"]);
      expect((await fetch(`${base}/images/light.kitchen`)).status).toBe(200);

      expect((await upload(base, "light.kitchen", "a.jpg")).status).toBe(200);
      expect(images("light.kitchen")).toEqual(["light.kitchen.jpg"]);

      const res = await fetch(`${base}/images/light.kitchen`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(images("light.kitchen")).toEqual([]);
    });
  });

  it("treats invalid ids in a batch resolve as having no image", async () => {
    await withRouter(async (base) => {
      await upload(base, "light.c", "image.png");
      // what an older version stored for the id ".."
      writeFileSync(join(imagesDir, "...png"), "");
      const res = await fetch(`${base}/images/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entityIds: ["light.c", "..", "a".repeat(300), 123, null, {}, ["a"]],
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        "light.c": { source: "custom" },
        "..": { source: "none" },
        ["a".repeat(300)]: { source: "none" },
        "123": { source: "none" },
        null: { source: "none" },
        "[object Object]": { source: "none" },
        a: { source: "none" },
      });
    });
  });

  it("answers a disk failure with 500 and no path", async () => {
    const broken = mkdtempSync(join(tmpdir(), "hamh-device-image-"));
    try {
      await withRouter(async (base) => {
        // a file where the images dir was: ENOTDIR even as root
        rmSync(join(broken, "device-images"), { recursive: true });
        writeFileSync(join(broken, "device-images"), "");
        const res = await upload(base, "light.d", "image.png");
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(JSON.parse(body)).toEqual({ error: "Upload failed" });
        expect(body).not.toContain(broken);
      }, broken);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
