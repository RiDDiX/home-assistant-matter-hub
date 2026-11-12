import { mkdtempSync, rmSync } from "node:fs";
import type * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LoggerService } from "../core/app/logger.js";
import { WebApi } from "./web-api.js";

type Credentials = { username: string; password: string };
type Verify = (header: string | undefined) => Promise<boolean> | boolean;

const basic = (decoded: string) =>
  `Basic ${Buffer.from(decoded).toString("base64")}`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

function settingsStorage(stored?: Credentials, failVerify = false) {
  let current = stored;
  return {
    get auth() {
      return current && { username: current.username };
    },
    async setAuth(credentials: Credentials | undefined) {
      current = credentials;
    },
    async verifyAuth(username: string, password: string) {
      if (failVerify) {
        throw new Error("verify failed");
      }
      return current?.username === username && current?.password === password;
    },
  };
}

async function webApi(
  storage: ReturnType<typeof settingsStorage>,
  envAuth?: Credentials,
) {
  const dir = mkdtempSync(join(tmpdir(), "hamh-web-api-auth-"));
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
    storage as never,
    stub,
    {
      port: 0,
      whitelist: undefined,
      allowedHosts: [],
      version: "test",
      storageLocation: dir,
      basePath: "/",
      auth: envAuth,
    },
  );
  await api.construction;
  return api;
}

describe("WebApi.verifyAuthorization", () => {
  const env = { username: "admin", password: "secret" };
  const stored = { username: "user", password: "pass" };
  const cases: Array<{
    name: string;
    env?: Credentials;
    stored?: Credentials;
    failVerify?: boolean;
    header?: string;
    ok: boolean;
  }> = [
    { name: "no auth configured", ok: true },
    { name: "env ok", env, header: basic("admin:secret"), ok: true },
    { name: "env wrong user", env, header: basic("root:secret"), ok: false },
    {
      name: "env wrong password",
      env,
      header: basic("admin:nope"),
      ok: false,
    },
    { name: "stored ok", stored, header: basic("user:pass"), ok: true },
    { name: "stored wrong", stored, header: basic("user:nope"), ok: false },
    { name: "missing header", env, ok: false },
    { name: "missing header stored", stored, ok: false },
    {
      name: "non-Basic scheme",
      env,
      header: `Bearer ${Buffer.from("admin:secret").toString("base64")}`,
      ok: false,
    },
    {
      name: "Basic without colon",
      env,
      header: basic("adminsecret"),
      ok: false,
    },
    {
      name: "password with a colon",
      env: { username: "admin", password: "se:cr:et" },
      header: basic("admin:se:cr:et"),
      ok: true,
    },
    {
      name: "stored password with a colon",
      stored: { username: "user", password: "a:b" },
      header: basic("user:a:b"),
      ok: true,
    },
    {
      name: "stored verify rejects",
      stored,
      failVerify: true,
      header: basic("user:pass"),
      ok: false,
    },
  ];

  it.each(cases)("$name", async (c) => {
    const api = await webApi(settingsStorage(c.stored, c.failVerify), c.env);
    const verify = (api as unknown as { verifyAuthorization: Verify })
      .verifyAuthorization;
    expect(await verify.call(api, c.header)).toBe(c.ok);
  });
});

// Resolves true on open, or the HTTP status of a refused upgrade.
function upgrade(ws: WebSocket) {
  cleanup.push(async () => ws.terminate());
  return new Promise<true | number>((resolve, reject) => {
    ws.once("open", () => resolve(true));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", reject);
  });
}

describe("WebApi auth change", () => {
  it("drops open sockets when the password is set", async () => {
    const api = await webApi(settingsStorage());
    await api.start();
    cleanup.push(() => api.dispose());
    const server = (api as unknown as { server: http.Server }).server;
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;

    const open = new WebSocket(`ws://${host}/api/ws`);
    expect(await upgrade(open)).toBe(true);
    const closed = new Promise((resolve) => open.once("close", resolve));

    const res = await fetch(`http://${host}/api/settings/auth`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "user", password: "pass" }),
    });
    expect(res.status).toBe(200);
    await closed;

    expect(await upgrade(new WebSocket(`ws://${host}/api/ws`))).toBe(401);
  });
});
