import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoggerService } from "../core/app/logger.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import { diagnosticApi } from "./diagnostic-api.js";
import { addLogEntry, logBuffer } from "./logs-api.js";

// a 1 GB host, where the ring used to shrink
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const totalmem = () => 1024 * 1024 * 1024;
  return { ...real, totalmem, default: { ...real, totalmem } };
});

vi.mock("./network-diagnostic-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./network-diagnostic-api.js")>()),
  runDiagnostics: vi.fn(async () => ({ interfaces: [], checks: [] })),
}));

function fill(count: number) {
  for (let i = 0; i < count; i++) {
    addLogEntry({
      timestamp: new Date(0).toISOString(),
      level: "info",
      message: `line ${i}`,
    });
  }
}

afterEach(() => {
  logBuffer.entries.length = 0;
});

describe("log ring", () => {
  it("keeps 1000 entries on every host", () => {
    expect(logBuffer.maxSize).toBe(1000);
  });

  it("keeps the newest entries when it overflows", () => {
    fill(logBuffer.maxSize + 25);
    expect(logBuffer.entries).toHaveLength(logBuffer.maxSize);
    expect(logBuffer.entries[0].message).toBe("line 25");
    expect(logBuffer.entries.at(-1)?.message).toBe(
      `line ${logBuffer.maxSize + 24}`,
    );
  });
});

async function exportLogs(query: string) {
  const app = express();
  app.use(
    "/diagnostic",
    diagnosticApi(
      { bridges: [] } as unknown as BridgeService,
      { connection: { connected: true } } as HomeAssistantClient,
      { entities: {}, devices: {} } as unknown as HomeAssistantRegistry,
      "1.2.3",
      Date.now(),
      { level: "INFO", protocolLevel: "INFO" } as unknown as LoggerService,
      undefined,
      true,
    ),
  );
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${port}/diagnostic/export?anonymize=false${query}`,
    );
    return (await res.json()).recentLogs as { message: string }[];
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("diagnostic export logs", () => {
  it("exports the whole ring by default", async () => {
    fill(logBuffer.maxSize + 5);
    const logs = await exportLogs("");
    expect(logs).toHaveLength(logBuffer.maxSize);
    expect(logs[0].message).toBe("line 5");
  });

  it("still honours logLimit", async () => {
    fill(50);
    const logs = await exportLogs("&logLimit=10");
    expect(logs.map((l) => l.message)).toEqual(
      Array.from({ length: 10 }, (_, i) => `line ${40 + i}`),
    );
  });
});
