import { Logger } from "@matter/general";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warnAboutAdvertising } from "./mdns.js";

const host = vi.hoisted(() => ({
  interfaces: {} as Record<
    string,
    { address: string; family: string; internal: boolean }[]
  >,
}));

vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  return { ...real, networkInterfaces: () => host.interfaces };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function addr(address: string) {
  return {
    address,
    family: address.includes(":") ? "IPv6" : "IPv4",
    internal: false,
  };
}

function warnings(stripGlobalIpv6: boolean, networkInterface?: string) {
  const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  // a second spyOn in one test returns the same spy
  warn.mockClear();
  warnAboutAdvertising({ ipv4: true, stripGlobalIpv6, networkInterface });
  return warn.mock.calls.map((c) => String(c[0]));
}

describe("warnAboutAdvertising", () => {
  it("warns about global IPv6 by default and not about Docker", () => {
    host.interfaces = {
      eth0: [addr("192.168.1.10"), addr("2001:db8::10")],
      docker0: [addr("172.17.0.1")],
      hassio: [addr("172.30.32.1")],
      veth1a2b: [addr("fe80::1")],
    };
    const lines = warnings(false);
    expect(lines.some((l) => l.includes("global IPv6"))).toBe(true);
    expect(lines.some((l) => l.includes("Docker"))).toBe(false);
  });

  it("stays quiet when global IPv6 is stripped", () => {
    host.interfaces = {
      eth0: [addr("192.168.1.10"), addr("2001:db8::10")],
      docker0: [addr("172.17.0.1")],
    };
    expect(warnings(true)).toEqual([]);
  });

  it("checks only the configured interface for global IPv6", () => {
    host.interfaces = {
      eth0: [addr("192.168.1.10"), addr("fe80::10")],
      eth1: [addr("10.0.0.10"), addr("2001:db8::10")],
    };
    expect(warnings(false, "eth0")).toEqual([]);
    expect(warnings(false, "eth1").some((l) => l.includes("global IPv6"))).toBe(
      true,
    );
  });

  it("names a configured interface that does not exist", () => {
    host.interfaces = { eth0: [addr("192.168.1.10")] };
    const lines = warnings(false, "nope0");
    expect(lines.some((l) => l.includes('"nope0"') && l.includes("eth0"))).toBe(
      true,
    );
  });

  it("points a Thread interface at the OTBR route, pinned or not", () => {
    host.interfaces = {
      eth0: [addr("192.168.1.10"), addr("fd10::10")],
      wpan0: [addr("fd11::1"), addr("fe80::1")],
    };
    for (const pinned of [undefined, "eth0"]) {
      const lines = warnings(false, pinned).filter((l) => l.includes("#388"));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("fc00::/7");
      expect(lines[0]).not.toContain("Set mdns-network-interface");
    }
  });

  it("warns a container that only has a Docker network address", () => {
    host.interfaces = { eth0: [addr("172.17.0.2"), addr("fe80::2")] };
    expect(warnings(false).some((l) => l.includes("host networking"))).toBe(
      true,
    );
    expect(warnings(false, "eth0")).toEqual([]);
  });

  it("does not blame host networking when the LAN link is down", () => {
    host.interfaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      docker0: [addr("172.17.0.1")],
      hassio: [addr("172.30.32.1")],
    };
    expect(warnings(false).some((l) => l.includes("host networking"))).toBe(
      false,
    );
  });

  it("does not warn a HA OS host about host networking", () => {
    host.interfaces = {
      end0: [addr("10.0.0.209"), addr("fe80::1")],
      docker0: [addr("172.30.232.1")],
      hassio: [addr("172.30.32.1")],
    };
    expect(warnings(false)).toEqual([]);
  });
});
