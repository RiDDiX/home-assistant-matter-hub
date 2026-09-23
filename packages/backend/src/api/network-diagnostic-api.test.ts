import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type NetworkDiagnosticCheck,
  runDiagnostics,
} from "./network-diagnostic-api.js";

// #478: probes a live listener on port 80

let listener: net.Server | undefined;

afterEach(async () => {
  if (listener) {
    await new Promise<void>((resolve) => listener?.close(() => resolve()));
    listener = undefined;
  }
});

function port80Check(checks: NetworkDiagnosticCheck[]) {
  return checks.find((c) => c.name === "port_80_in_use");
}

type BindResult = "free" | "busy" | "denied";

// both tests skip when this runner can't own port 80
async function bind80(): Promise<BindResult> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(80, "127.0.0.1", () => resolve());
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") return "busy";
    if (code === "EACCES" || code === "EPERM") return "denied";
    throw e;
  }
  listener = server;
  return "free";
}

describe("network diagnostics port 80 check", () => {
  it("stays quiet when nothing answers on port 80", async (ctx) => {
    if ((await bind80()) !== "free") {
      ctx.skip();
      return;
    }
    await new Promise<void>((resolve) => listener?.close(() => resolve()));
    listener = undefined;

    const result = await runDiagnostics(undefined, true);
    expect(port80Check(result.checks)).toBeUndefined();
  });

  it("warns when something is listening on port 80", async (ctx) => {
    if ((await bind80()) !== "free") {
      ctx.skip();
      return;
    }

    const result = await runDiagnostics(undefined, true);
    const check = port80Check(result.checks);
    expect(check).toBeDefined();
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("127.0.0.1");
  });
});
