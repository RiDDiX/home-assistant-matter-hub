import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebSocketMessage } from "@home-assistant-matter-hub/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { BetterLogger } from "../core/app/logger.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import { WebSocketApi } from "./websocket-api.js";

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as BetterLogger;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function serve(
  bridges: Array<{ id: string; data: object }>,
  whitelist?: string[],
) {
  const bridgeService = {
    bridges,
    get: (id: string) => bridges.find((b) => b.id === id),
  } as unknown as BridgeService;
  const api = new WebSocketApi(log, bridgeService);
  const server = http.createServer();
  api.attach(server, "/", whitelist);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  cleanup.push(async () => {
    api.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return { api, server, base: `ws://127.0.0.1:${port}` };
}

// Resolves with the client and its first message, or rejects on a refused
// upgrade.
function connect(url: string) {
  const ws = new WebSocket(url);
  cleanup.push(async () => ws.close());
  const messages: WebSocketMessage[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  return new Promise<{ ws: WebSocket; messages: WebSocketMessage[] }>(
    (resolve, reject) => {
      ws.once("error", reject);
      ws.once("message", () => resolve({ ws, messages }));
    },
  );
}

async function nextMessage(messages: WebSocketMessage[], count: number) {
  await vi.waitFor(() => expect(messages.length).toBeGreaterThan(count));
  return messages[count];
}

describe("WebSocketApi", () => {
  it("accepts the path a prefix-keeping proxy forwards", async () => {
    const { base } = await serve([]);

    const { messages } = await connect(`${base}/hamh/api/ws`);
    expect(messages[0].type).toBe("bridges_update");
    await expect(connect(`${base}/other`)).rejects.toThrow();
  });

  it("sends the whole list when a changed bridge is gone", async () => {
    const bridges = [
      { id: "a", data: { id: "a" } },
      { id: "b", data: { id: "b" } },
    ];
    const { api, base } = await serve(bridges);
    const { messages } = await connect(`${base}/api/ws`);

    bridges.splice(0, 1);
    api.broadcastBridgeUpdate("a");

    expect(await nextMessage(messages, 1)).toEqual({
      type: "bridges_update",
      data: [{ id: "b" }],
    });
  });

  it("applies the ip whitelist to upgrades", async () => {
    const denied = await serve([], ["10.0.0.1"]);
    await expect(connect(`${denied.base}/api/ws`)).rejects.toThrow("401");

    const allowed = await serve([], ["127.0.0.1"]);
    const { messages } = await connect(`${allowed.base}/api/ws`);
    expect(messages[0].type).toBe("bridges_update");
  });

  it("closes the socket on an oversized message", async () => {
    const { base } = await serve([]);
    const { ws } = await connect(`${base}/api/ws`);

    const code = new Promise<number>((resolve) => ws.once("close", resolve));
    ws.send("x".repeat(65 * 1024));
    expect(await code).toBe(1009);
  });

  it("lets the http server close while a client is connected", async () => {
    const { api, server, base } = await serve([]);
    await connect(`${base}/api/ws`);

    api.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
