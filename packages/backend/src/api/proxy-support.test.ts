import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { BetterLogger } from "../core/app/logger.js";
import { supportProxyPrefix } from "./proxy-support.js";

const ingress = "/api/hassio_ingress/abc";

describe("supportProxyPrefix", () => {
  it.each<{
    name: string;
    mount?: string;
    path: string;
    headers: Record<string, string>;
    expected: { baseUrl: string; url: string; originalUrl?: string };
    warnings?: number;
  }>([
    {
      name: "ingress path in both headers",
      path: "/api/x",
      headers: { "x-ingress-path": ingress, "x-forwarded-prefix": ingress },
      expected: { baseUrl: ingress, url: "/api/x" },
    },
    {
      name: "Home Assistant ingress without X-Forwarded-Prefix",
      path: "/api/x",
      headers: { "x-ingress-path": ingress },
      expected: { baseUrl: ingress, url: "/api/x" },
    },
    {
      name: "ingress path in X-Forwarded-Prefix only",
      path: "/api/x",
      headers: { "x-forwarded-prefix": ingress },
      expected: { baseUrl: ingress, url: "/api/x" },
    },
    {
      name: "X-Forwarded-Prefix over X-Ingress-Path",
      path: "/api/x",
      headers: { "x-ingress-path": "/old", "x-forwarded-prefix": ingress },
      expected: { baseUrl: ingress, url: "/api/x" },
    },
    {
      name: "reverse proxy that removes X-Forwarded-Prefix from the URL",
      path: "/api/x",
      headers: { "x-forwarded-prefix": "hamh/" },
      expected: { baseUrl: "/hamh", url: "/api/x" },
    },
    {
      name: "reverse proxy that leaves two slashes",
      path: "//api/x",
      headers: { "x-forwarded-prefix": "/hamh" },
      expected: { baseUrl: "/hamh", url: "/api/x" },
    },
    {
      name: "query that looks like a path",
      path: "/api/x?u=a//b/../c",
      headers: { "x-forwarded-prefix": "/hamh" },
      expected: { baseUrl: "/hamh", url: "/api/x?u=a//b/../c" },
    },
    {
      name: "reverse proxy that keeps X-Forwarded-Prefix in the URL",
      path: "/hamh/api/x",
      headers: { "x-forwarded-prefix": "/hamh" },
      expected: { baseUrl: "/hamh", url: "/api/x" },
      warnings: 1,
    },
    {
      name: "reverse proxy with an empty X-Forwarded-Prefix",
      path: "/api/x",
      headers: { "x-forwarded-prefix": "" },
      expected: { baseUrl: "", url: "/api/x" },
    },
    {
      name: "reverse proxy with a root X-Forwarded-Prefix",
      path: "/api/x",
      headers: { "x-forwarded-prefix": "/" },
      expected: { baseUrl: "", url: "/api/x" },
    },
    {
      name: "reverse proxy with a longer path that starts like the prefix",
      path: "/hamh2/api/x",
      headers: { "x-forwarded-prefix": "/hamh" },
      expected: { baseUrl: "/hamh", url: "/hamh2/api/x" },
    },
    {
      name: "X-Ingress-Path that is also in the URL",
      path: "/api/x",
      headers: { "x-ingress-path": "/api" },
      expected: { baseUrl: "/api", url: "/api/x" },
    },
    {
      name: "empty X-Forwarded-Prefix with X-Ingress-Path",
      path: "/api/x",
      headers: { "x-forwarded-prefix": "", "x-ingress-path": "/i" },
      expected: { baseUrl: "/i", url: "/api/x", originalUrl: "/i/api/x" },
    },
    {
      name: "router mounted under a base path",
      mount: "/b",
      path: "/b/api/x",
      headers: { "x-forwarded-prefix": "/i" },
      expected: { baseUrl: "/i/b", url: "/api/x", originalUrl: "/i/b/api/x" },
    },
    {
      name: "prefix with % ~ . _ -",
      path: "/api/x",
      headers: { "x-forwarded-prefix": "/a%20b/~c.d_e-f" },
      expected: {
        baseUrl: "/a%20b/~c.d_e-f",
        url: "/api/x",
        originalUrl: "/a%20b/~c.d_e-f/api/x",
      },
    },
  ])("resolves the base url for $name", async ({
    mount = "/",
    path,
    headers,
    expected,
    warnings = 0,
  }) => {
    const log = { warn: vi.fn() };
    const app = express().use(
      mount,
      express
        .Router()
        .use(supportProxyPrefix(log as never as BetterLogger))
        .use(({ baseUrl, url, originalUrl }, res) =>
          res.json({ baseUrl, url, originalUrl }),
        ),
    );
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      // The second request must not warn again.
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          originalUrl: expected.baseUrl + expected.url,
          ...expected,
        });
      }
      expect(log.warn).toHaveBeenCalledTimes(warnings);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    "\\evil.example",
    "/a\t/evil.example",
    "/a, /b",
  ])("rejects the prefix %j", async (prefix) => {
    const reached = vi.fn();
    const app = express()
      .use(supportProxyPrefix({ warn: vi.fn() } as never as BetterLogger))
      .use(reached);
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/x`, {
        headers: { "x-forwarded-prefix": prefix },
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await res.text()).toBe(
        "X-Forwarded-Prefix or X-Ingress-Path must be a plain path like /hamh",
      );
      expect(reached).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
