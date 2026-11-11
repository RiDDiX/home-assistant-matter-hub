import * as net from "node:net";
import type * as os from "node:os";
import {
  type BridgeDataWithMetadata,
  BridgeStatus,
} from "@home-assistant-matter-hub/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type NetworkDiagnosticCheck,
  runDiagnostics,
} from "./network-diagnostic-api.js";

let fakeInterfaces: ReturnType<typeof os.networkInterfaces> | undefined;

vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const networkInterfaces = () => fakeInterfaces ?? real.networkInterfaces();
  return { ...real, networkInterfaces };
});

function addr(address: string): os.NetworkInterfaceInfo {
  const v6 = address.includes(":");
  return {
    address,
    family: v6 ? "IPv6" : "IPv4",
    internal: false,
    mac: "00:11:22:33:44:55",
    netmask: v6 ? "ffff:ffff:ffff:ffff::" : "255.255.255.0",
    cidr: null,
    ...(v6 ? { scopeid: 0 } : {}),
  } as os.NetworkInterfaceInfo;
}

// #478: probes a live listener on port 80

let listener: net.Server | undefined;

afterEach(async () => {
  fakeInterfaces = undefined;
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

describe("network diagnostics ipv6 check", () => {
  const ipv6Check = async (mdnsInterface?: string) =>
    (await runDiagnostics(mdnsInterface, true)).checks.find(
      (c) => c.name === "ipv6_available",
    );

  // the IPv4 is loopback so the port 80 probe fails fast
  it("warns when the configured interface has no IPv6", async () => {
    fakeInterfaces = {
      eth0: [addr("127.0.0.1")],
      docker0: [addr("fe80::1")],
    };
    const check = await ipv6Check("eth0");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("No IPv6 address is advertised");
  });

  it("ignores container links when no interface is configured", async () => {
    fakeInterfaces = {
      eth0: [addr("127.0.0.1")],
      veth1a2b: [addr("fe80::1")],
    };
    expect((await ipv6Check())?.status).toBe("warn");

    fakeInterfaces.eth0 = [addr("127.0.0.1"), addr("fe80::2")];
    expect((await ipv6Check())?.status).toBe("pass");
  });
});

describe("network diagnostics unpaired bridges check", () => {
  const bridge = (isCommissioned: boolean) =>
    ({
      status: BridgeStatus.Running,
      commissioning: { isCommissioned },
    }) as BridgeDataWithMetadata;
  const unpairedCheck = async (bridges: BridgeDataWithMetadata[]) =>
    (await runDiagnostics(undefined, true, bridges)).checks.find(
      (c) => c.name === "multiple_unpaired_bridges",
    );

  it("stays quiet with one unpaired bridge", async () => {
    expect(await unpairedCheck([])).toBeUndefined();
    expect(await unpairedCheck([bridge(false), bridge(true)])).toBeUndefined();
  });

  it("warns when two bridges wait to be paired", async () => {
    const check = await unpairedCheck([bridge(false), bridge(false)]);
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("Alexa");
  });
});
