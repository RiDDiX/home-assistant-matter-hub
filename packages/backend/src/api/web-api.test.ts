import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as http from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { LoggerService } from "../core/app/logger.js";
import { isLoopback, WebApi } from "./web-api.js";

// Tests cannot connect from 172.30.32.2, so force the ingress predicate.
const ingress = vi.hoisted(() => ({
  forced: false,
  addresses: [] as Array<string | undefined>,
}));
vi.mock("./host-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./host-guard.js")>();
  return {
    ...actual,
    isSupervisorIngress: (
      ...args: Parameters<typeof actual.isSupervisorIngress>
    ) => {
      ingress.addresses.push(args[1]);
      return ingress.forced || actual.isSupervisorIngress(...args);
    },
  };
});

const auth = { username: "admin", password: "secret" };
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  ingress.forced = false;
  ingress.addresses = [];
  vi.unstubAllEnvs();
  while (cleanup.length) await cleanup.pop()?.();
});

// Stored settings auth is user:pass and replaces the env credentials.
async function serve(
  whitelist?: string[],
  {
    dir = mkdtempSync(join(tmpdir(), "hamh-web-api-")),
    stored = false,
    anonymous = false,
    allowedHosts = [] as string[],
    basePath = "/",
  } = {},
) {
  cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
  const stub = {} as never;
  const settings = stored
    ? {
        auth: { username: "user" },
        verifyAuth: async (username: string, password: string) =>
          username === "user" && password === "pass",
      }
    : { auth: undefined };
  const api = new WebApi(
    new LoggerService({ level: "error", disableColors: true }),
    { bridges: [] } as never,
    stub,
    stub,
    { bridges: [] } as never,
    stub,
    stub,
    stub,
    settings as never,
    stub,
    {
      port: 0,
      whitelist,
      allowedHosts,
      version: "test",
      storageLocation: dir,
      basePath,
      auth: stored || anonymous ? undefined : auth,
    },
  );
  await api.construction;
  await api.start();
  cleanup.push(() => api.dispose());
  const server = (api as unknown as { server: http.Server }).server;
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function get(
  host: string,
  path: string,
  authorization?: string,
  headers: Record<string, string> = {},
) {
  return fetch(`http://${host}${path}`, {
    headers: authorization ? { ...headers, authorization } : headers,
  }).then((res) => res.status);
}

// Resolves true on open, or the HTTP status of a refused upgrade.
function upgrade(
  host: string,
  authorization?: string,
  headers: Record<string, string> = {},
) {
  const ws = new WebSocket(`ws://${host}/api/ws`, {
    headers: authorization ? { ...headers, authorization } : headers,
  });
  cleanup.push(async () => ws.terminate());
  return new Promise<true | number>((resolve, reject) => {
    ws.once("open", () => resolve(true));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", reject);
  });
}

describe("WebApi auth", () => {
  it("limits unauthenticated administration to local setup and verified ingress", async () => {
    const host = await serve(undefined, { anonymous: true });
    const forwarded = { "x-forwarded-for": "192.0.2.1" };
    expect(await get(host, "/api/settings/auth")).toBe(200);
    expect(await get(host, "/api/settings/auth", undefined, forwarded)).toBe(
      403,
    );
    expect(await get(host, "/api/plugins", undefined, forwarded)).toBe(403);
    expect(await upgrade(host, undefined, forwarded)).toBe(401);
    ingress.forced = true;
    expect(await get(host, "/api/settings/auth", undefined, forwarded)).toBe(
      200,
    );
    expect(await upgrade(host, undefined, forwarded)).toBe(true);
  });

  it("refuses a proxied host name on the loopback socket without a login", async () => {
    const allowedHosts = ["hamh.example.com"];
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request(
          `http://${host}/api/settings/auth`,
          { headers: { host: "hamh.example.com" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
          .on("error", reject)
          .end();
      });
    // 401 with a login: the host guard lets the name through
    expect(await status(await serve(undefined, { allowedHosts }))).toBe(401);
    expect(
      await status(await serve(undefined, { anonymous: true, allowedHosts })),
    ).toBe(403);
  });

  it("lets a whitelisted address in without a login", async () => {
    const host = await serve(["127.0.0.1"], { anonymous: true });
    const forwarded = { "x-forwarded-for": "192.0.2.1" };
    expect(await get(host, "/api/settings/auth", undefined, forwarded)).toBe(
      200,
    );
    expect(await upgrade(host, undefined, forwarded)).toBe(true);
  });

  it("lets a proxy that handles the login in by its address (#558)", async () => {
    const host = await serve(["127.0.0.1"], {
      anonymous: true,
      allowedHosts: ["matter.example.org"],
    });
    const headers = {
      host: "matter.example.org",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
      "cf-connecting-ip": "203.0.113.9",
    };
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request(`http://${host}/api/settings/auth`, { headers }, (res) => {
        res.resume();
        resolve(res);
      })
        .on("error", reject)
        .end();
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(
      await upgrade(host, undefined, {
        ...headers,
        origin: "https://matter.example.org",
      }),
    ).toBe(true);
  });

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

  it("denies loopback with the add-on default whitelist", async () => {
    const host = await serve(["172.30.32.2"]);
    expect(await get(host, "/api/settings/auth")).toBe(403);
    expect(
      await get(host, "/api/settings/auth", basic("admin", "secret")),
    ).toBe(403);
    expect(await upgrade(host, basic("admin", "secret"))).toBe(403);
    expect(await get(host, "/api/health/live")).toBe(200);
    expect(await get(host, "/api/health/ready")).not.toBe(403);
  });

  it("challenges whitelisted loopback clients with the env credentials", async () => {
    const host = await serve(["172.30.32.2", "127.0.0.1", "::1"]);
    expect(await get(host, "/api/settings/auth")).toBe(401);
    expect(await get(host, "/api/settings/auth", basic("admin", "wrong"))).toBe(
      401,
    );
    expect(
      await get(host, "/api/settings/auth", basic("admin", "secret")),
    ).toBe(200);
    expect(await upgrade(host)).toBe(401);
    expect(await upgrade(host, basic("admin", "wrong"))).toBe(401);
    expect(await upgrade(host, basic("admin", "secret"))).toBe(true);
  });

  it("lets supervisor ingress skip the env credentials", async () => {
    ingress.forced = true;
    const host = await serve();
    const loopback = ["127.0.0.1", "::ffff:127.0.0.1"];
    expect(await get(host, "/api/settings/auth")).toBe(200);
    expect(ingress.addresses).toHaveLength(1);
    expect(loopback).toContain(ingress.addresses[0]);
    expect(await upgrade(host)).toBe(true);
    expect(ingress.addresses).toHaveLength(2);
    expect(loopback).toContain(ingress.addresses[1]);
  });

  it.each([
    "x-forwarded-prefix",
    "x-ingress-path",
  ])("keeps the env credentials for a spoofed %s", async (header) => {
    vi.stubEnv("SUPERVISOR_TOKEN", "token");
    const host = await serve(["127.0.0.1", "::1"]);
    const headers = { [header]: "/api/hassio_ingress/abc" };
    expect(await get(host, "/api/settings/auth", undefined, headers)).toBe(401);
    expect(await upgrade(host, undefined, headers)).toBe(401);
  });

  it("redirects the root to the base path under the proxy prefix", async () => {
    const host = await serve(undefined, { basePath: "/b" });
    const location = (headers?: Record<string, string>) =>
      fetch(`http://${host}/`, { headers, redirect: "manual" }).then((res) =>
        res.headers.get("location"),
      );
    expect(await location()).toBe("/b");
    expect(await location({ "x-forwarded-prefix": "/i" })).toBe("/i/b");
  });

  it("still challenges ingress with stored settings auth", async () => {
    ingress.forced = true;
    const host = await serve(undefined, { stored: true });
    expect(await get(host, "/api/settings/auth")).toBe(401);
    expect(await get(host, "/api/settings/auth", basic("user", "pass"))).toBe(
      200,
    );
    expect(await upgrade(host)).toBe(401);
    expect(await upgrade(host, basic("user", "pass"))).toBe(true);
  });

  it("refuses to change env credentials from the ui", async () => {
    const host = await serve();
    const res = await fetch(`http://${host}/api/settings/auth`, {
      method: "PUT",
      headers: {
        authorization: basic("admin", "secret"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "user", password: "pass" }),
    });
    expect(res.status).toBe(409);
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
    const host = await serve(undefined, { dir });
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
