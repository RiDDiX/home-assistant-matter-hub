import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import { pluginApi } from "./plugin-api.js";

// A server mode bridge carries none of the plugin surface: no pluginInfo, no
// enablePlugin and friends. The plugins API must skip it in the listing and
// answer the per-bridge routes cleanly instead of 500ing the page (#430).

const dir = mkdtempSync(join(tmpdir(), "hamh-plugin-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pluginBridge = {
  id: "b1",
  data: { name: "Bridge One" },
  pluginInfo: { metadata: [], circuitBreakers: {}, devices: [] },
};
const serverModeBridge = {
  id: "sm1",
  data: { name: "Vacuum" },
  // no pluginInfo, no plugin methods
};

function service(): BridgeService {
  return {
    bridges: [pluginBridge, serverModeBridge],
    get: (id: string) =>
      [pluginBridge, serverModeBridge].find((b) => b.id === id),
  } as unknown as BridgeService;
}

async function withRouter(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/plugins", pluginApi(service(), dir));
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("plugin api with a server mode bridge present (#430)", () => {
  it("lists plugins without 500ing, skipping the server mode bridge", async () => {
    await withRouter(async (base) => {
      const res = await fetch(`${base}/plugins`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ bridgeId: string }>;
      const ids = body.map((b) => b.bridgeId);
      expect(ids).toContain("b1");
      expect(ids).not.toContain("sm1");
    });
  });

  it("answers per-bridge plugin routes with 400 for a server mode bridge", async () => {
    await withRouter(async (base) => {
      const res = await fetch(`${base}/plugins/sm1/camera/enable`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("does not support plugins");
    });
  });

  it("still 404s for an unknown bridge id", async () => {
    await withRouter(async (base) => {
      const res = await fetch(`${base}/plugins/nope/camera/enable`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });
});
