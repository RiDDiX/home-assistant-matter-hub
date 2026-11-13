import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LoggerService } from "../core/app/logger.js";
import { isLoopback, WebApi } from "./web-api.js";

const auth = { username: "admin", password: "secret" };
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function serve(
  whitelist?: string[],
  dir = mkdtempSync(join(tmpdir(), "hamh-web-api-")),
) {
  cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
  const stub = {} as never;
  const api = new WebApi(
    new LoggerService({ level: "error", disableColors: true }),
    { bridges: [] } as never,
    stub,
    stub,
    { bridges: [] } as never,
    stub,
    stub,
    stub,
    { auth: undefined } as never,
    stub,
    {
      port: 0,
      whitelist,
      allowedHosts: [],
      version: "test",
      storageLocation: dir,
      basePath: "/",
      auth,
    },
  );
  await api.construction;
  await api.start();
  cleanup.push(() => api.dispose());
  const server = (api as unknown as { server: http.Server }).server;
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function get(host: string, path: string, authorization?: string) {
  return fetch(`http://${host}${path}`, {
    headers: authorization ? { authorization } : {},
  }).then((res) => res.status);
}

// Resolves true on open, or the HTTP status of a refused upgrade.
function upgrade(host: string, authorization?: string) {
  const ws = new WebSocket(`ws://${host}/api/ws`, {
    headers: authorization ? { authorization } : {},
  });
  cleanup.push(async () => ws.terminate());
  return new Promise<true | number>((resolve, reject) => {
    ws.once("open", () => resolve(true));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", reject);
  });
}

describe("WebApi auth", () => {
  it("requires credentials over http", async () => {
    const host = await serve();
    expect(await get(host, "/api/settings/auth")).toBe(401);
    expect(await get(host, "/api/settings/auth", basic("admin", "wrong"))).toBe(
      401,
    );
    expect(
      await get(host, "/api/settings/auth", basic("admin", "secret")),
    ).toBe(200);
  });

  it("leaves the liveness probe open", async () => {
    const host = await serve();
    expect(await get(host, "/api/health/live")).toBe(200);
  });

  it("requires credentials for the websocket upgrade", async () => {
    const host = await serve();
    expect(await upgrade(host)).toBe(401);
    expect(await upgrade(host, basic("admin", "wrong"))).toBe(401);
    expect(await upgrade(host, basic("admin", "secret"))).toBe(true);
  });

  it("denies a non-whitelisted client before the auth challenge", async () => {
    const host = await serve(["10.0.0.0/8"]);
    expect(await get(host, "/api/settings/auth")).toBe(403);
    expect(await upgrade(host)).toBe(403);
  });

  it("keeps the liveness probe reachable outside the whitelist", async () => {
    const host = await serve(["10.0.0.0/8"]);
    expect(await get(host, "/api/health/live")).toBe(200);
  });

  it("names the rejected origin in plain text", async () => {
    const host = await serve();
    const res = await fetch(`http://${host}/api/settings/auth`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(
      "Origin evil.example is not allowed, add it with --http-allowed-hosts",
    );
  });

  it("answers errors as json without paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hamh-web-api-"));
    const host = await serve(undefined, dir);
    rmSync(join(dir, "bridge-icons"), { recursive: true });
    writeFileSync(join(dir, "bridge-icons"), "");
    const authorization = basic("admin", "secret");
    const broken = await fetch(`http://${host}/api/bridge-icons/b1`, {
      headers: { authorization },
    });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: "Internal server error" });
    const malformed = await fetch(`http://${host}/api/settings/auth`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toMatch(/json/);
    expect(await malformed.json()).toHaveProperty("error");
  });

  it("lets only loopback probes skip the whitelist", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.11")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("192.168.1.99")).toBe(false);
    expect(isLoopback("::ffff:192.168.1.99")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
