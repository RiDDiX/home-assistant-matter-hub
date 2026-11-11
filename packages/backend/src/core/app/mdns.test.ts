import { Logger } from "@matter/general";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warnAboutAdvertising } from "./mdns.js";

vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const networkInterfaces = () => ({
    eth0: [
      { address: "192.168.1.10", family: "IPv4", internal: false },
      { address: "2001:db8::10", family: "IPv6", internal: false },
    ],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
  });
  return { ...real, networkInterfaces };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function warnings(stripGlobalIpv6: boolean) {
  const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  warnAboutAdvertising({ ipv4: true, stripGlobalIpv6 });
  return warn.mock.calls.map((c) => String(c[0]));
}

describe("warnAboutAdvertising", () => {
  it("warns about Docker and global IPv6 by default", () => {
    const lines = warnings(false);
    expect(lines.some((l) => l.includes("Docker-internal"))).toBe(true);
    expect(lines.some((l) => l.includes("global IPv6"))).toBe(true);
  });

  it("keeps the Docker warning when global IPv6 is stripped", () => {
    const lines = warnings(true);
    expect(lines.some((l) => l.includes("Docker-internal"))).toBe(true);
    expect(lines.some((l) => l.includes("global IPv6"))).toBe(false);
  });
});
