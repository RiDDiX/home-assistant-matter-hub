import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { BetterLogger } from "../core/app/logger.js";
import { supportProxyPrefix } from "./proxy-support.js";

const ingress = "/api/hassio_ingress/abc";

describe("proxy support", () => {
  it.each<{
    name: string;
    path: string;
    headers: Record<string, string>;
    expected: { baseUrl: string; url: string };
    warnings?: number;
  }>([
    {
      name: "Home Assistant ingress with X-Forwarded-Prefix",
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
      name: "Home Assistant ingress without X-Ingress-Path",
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
  ])("resolves the base url for $name", async ({
    path,
    headers,
    expected,
    warnings = 0,
  }) => {
    const log = { warn: vi.fn() };
    const app = express()
      .use(supportProxyPrefix(log as never as BetterLogger))
      .use((req, res) => res.json({ baseUrl: req.baseUrl, url: req.url }));
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      // The second request must not warn again.
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(expected);
      }
      expect(log.warn).toHaveBeenCalledTimes(warnings);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
