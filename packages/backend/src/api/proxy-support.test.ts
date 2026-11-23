import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { supportIngress, supportProxyLocation } from "./proxy-support.js";

const ingress = "/api/hassio_ingress/abc";

describe("proxy support", () => {
  it.each<{
    name: string;
    path: string;
    headers: Record<string, string>;
    expected: { baseUrl: string; url: string };
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
      name: "reverse proxy with X-Forwarded-Prefix",
      path: "/hamh/api/x",
      headers: { "x-forwarded-prefix": "/hamh" },
      expected: { baseUrl: "/hamh", url: "/api/x" },
    },
  ])("resolves the base url for $name", async ({ path, headers, expected }) => {
    const app = express()
      .use(supportIngress, supportProxyLocation)
      .use((req, res) => res.json({ baseUrl: req.baseUrl, url: req.url }));
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
