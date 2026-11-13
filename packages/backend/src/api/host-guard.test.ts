import { describe, expect, it, vi } from "vitest";
import type { BetterLogger } from "../core/app/logger.js";
import {
  crossSiteMessage,
  crossSiteReason,
  ipWhitelist,
  isSupervisorIngress,
} from "./host-guard.js";

const fakeLog = () => ({ warn: vi.fn(), debug: vi.fn() });

describe("ipWhitelist", () => {
  it("warns on the first denial per address, then logs at debug", () => {
    const log = fakeLog();
    const allowed = ipWhitelist(["172.30.32.2"], log as never as BetterLogger);
    expect(allowed("172.30.32.2")).toBe(true);
    expect(allowed("::ffff:172.30.32.2")).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();

    expect(allowed("127.0.0.1")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toBe(
      "Denied 127.0.0.1, not in --http-ip-whitelist",
    );
    expect(allowed("127.0.0.1")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(allowed("::1")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("keeps at most 50 denied addresses", () => {
    const log = fakeLog();
    const allowed = ipWhitelist(["10.0.0.1"], log as never as BetterLogger);
    for (let i = 0; i < 50; i++) allowed(`192.168.0.${i}`);
    expect(log.warn).toHaveBeenCalledTimes(50);
    expect(log.debug).not.toHaveBeenCalled();
    expect(allowed("192.168.0.50")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(50);
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(allowed("192.168.0.0")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(50);
    expect(log.debug).toHaveBeenCalledTimes(2);
  });

  it("warns once per malformed entry and never matches it", () => {
    const log = fakeLog();
    const entries = ["127.0.0.1/33", "localhost", "::1/129", "10.0.0.0/8"];
    const allowed = ipWhitelist(entries, log as never as BetterLogger);
    expect(log.warn.mock.calls.map((c) => c[0])).toEqual([
      'Ignoring --http-ip-whitelist entry "127.0.0.1/33", it is neither an IP nor a CIDR',
      'Ignoring --http-ip-whitelist entry "localhost", it is neither an IP nor a CIDR',
      'Ignoring --http-ip-whitelist entry "::1/129", it is neither an IP nor a CIDR',
    ]);
    expect(allowed("127.0.0.1")).toBe(false);
    expect(allowed("::1")).toBe(false);
    expect(allowed("10.1.2.3")).toBe(true);
  });

  it("trims whitespace around entries", () => {
    const log = fakeLog();
    const allowed = ipWhitelist(
      ["10.0.0.0/8 ", " 127.0.0.1"],
      log as never as BetterLogger,
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(allowed("10.1.2.3")).toBe(true);
    expect(allowed("127.0.0.1")).toBe(true);
  });
});

describe("isSupervisorIngress", () => {
  const headers = { "x-ingress-path": "/api/hassio_ingress/abc" };

  it("needs the token, the header and the supervisor address", () => {
    try {
      vi.stubEnv("HASSIO_TOKEN", "");
      vi.stubEnv("SUPERVISOR_TOKEN", "token");
      expect(isSupervisorIngress(headers, "172.30.32.2")).toBe(true);
      expect(isSupervisorIngress(headers, "::ffff:172.30.32.2")).toBe(true);
      expect(isSupervisorIngress({}, "172.30.32.2")).toBe(false);
      expect(
        isSupervisorIngress(
          { ...headers, "x-forwarded-for": "172.30.32.2" },
          "127.0.0.1",
        ),
      ).toBe(false);
      expect(isSupervisorIngress(headers, undefined)).toBe(false);
      vi.stubEnv("SUPERVISOR_TOKEN", "");
      expect(isSupervisorIngress(headers, "172.30.32.2")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("crossSiteReason", () => {
  it("allows IP, localhost and local names", () => {
    expect(crossSiteReason({ host: "192.168.1.5:8482" }, [])).toBeUndefined();
    expect(crossSiteReason({ host: "[::1]:8482" }, [])).toBeUndefined();
    expect(crossSiteReason({ host: "localhost:8482" }, [])).toBeUndefined();
    expect(crossSiteReason({ host: "nas" }, [])).toBeUndefined();
    expect(crossSiteReason({ host: "hamh.home.arpa" }, [])).toBeUndefined();
    expect(crossSiteReason({ host: "nas.fritz.box" }, [])).toBeUndefined();
    expect(crossSiteReason({ host: "hamh.lan.:8482" }, [])).toBeUndefined();
  });

  it("rejects public names unless allowed", () => {
    expect(crossSiteReason({ host: "hamh.example.com" }, [])).toBe("host");
    expect(crossSiteReason({}, [])).toBe("host");
    expect(
      crossSiteReason({ host: "HAMH.example.com" }, ["hamh.example.com"]),
    ).toBeUndefined();
    expect(
      crossSiteReason({ host: "a.b.example.com:8482" }, ["*.example.com"]),
    ).toBeUndefined();
    expect(
      crossSiteReason({ host: "hamh.example:8482" }, ["hamh.example:8482"]),
    ).toBeUndefined();
    expect(crossSiteReason({ host: "example.com" }, ["*.example.com"])).toBe(
      "host",
    );
  });

  it("checks the origin even with proxy headers", () => {
    const ingress = {
      host: "172.30.33.5:8099",
      origin: "https://ha.example.com",
      "x-ingress-path": "/api/hassio_ingress/abc",
    };
    expect(crossSiteReason(ingress, [], "172.30.32.2")).toBe("origin");
    expect(crossSiteReason(ingress, [], "192.168.1.20")).toBe("origin");
    expect(
      crossSiteReason(
        { host: "evil.com", "x-forwarded-for": "1.2.3.4" },
        [],
        "192.168.1.20",
      ),
    ).toBe("host");
    const sameHostProxy = {
      host: "127.0.0.1:8482",
      "x-forwarded-for": "192.168.1.20",
    };
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(
        crossSiteReason(
          { ...sameHostProxy, origin: "https://evil.example" },
          [],
          address,
        ),
      ).toBe("origin");
      expect(
        crossSiteReason(
          { ...sameHostProxy, origin: "https://matter.example.org" },
          ["matter.example.org"],
          address,
        ),
      ).toBeUndefined();
      expect(crossSiteReason(sameHostProxy, [], address)).toBeUndefined();
    }
    expect(
      crossSiteReason(
        { ...sameHostProxy, origin: "https://a.example.org" },
        ["*.example.org"],
        "127.0.0.1",
      ),
    ).toBeUndefined();
    expect(
      crossSiteReason(
        { ...sameHostProxy, origin: "https://example.org" },
        ["*.example.org"],
        "127.0.0.1",
      ),
    ).toBe("origin");
  });

  it("parses bracketed hosts strictly", () => {
    expect(crossSiteReason({ host: "" }, [])).toBe("host");
    expect(crossSiteReason({}, [])).toBe("host");
    expect(crossSiteReason({ host: "[::1]" }, [])).toBeUndefined();
    expect(
      crossSiteReason({ host: "[::ffff:127.0.0.1]:8482" }, []),
    ).toBeUndefined();
    expect(crossSiteReason({ host: "[::1" }, [])).toBe("host");
    expect(crossSiteReason({ host: "[::1:8482" }, [])).toBe("host");
  });

  it("skips both checks for add-on ingress from the supervisor", () => {
    const ingress = {
      host: "ha.example.com",
      "x-ingress-path": "/api/hassio_ingress/abc",
    };
    try {
      vi.stubEnv("HASSIO_TOKEN", "");
      vi.stubEnv("SUPERVISOR_TOKEN", "token");
      expect(crossSiteReason(ingress, [], "172.30.32.2")).toBeUndefined();
      expect(
        crossSiteReason(
          { ...ingress, origin: "https://ha.example.com" },
          [],
          "172.30.32.2",
        ),
      ).toBeUndefined();
      expect(
        crossSiteReason(
          { ...ingress, origin: "https://evil.example" },
          [],
          "172.30.32.2",
        ),
      ).toBeUndefined();
      expect(
        crossSiteReason(ingress, [], "::ffff:172.30.32.2"),
      ).toBeUndefined();
      for (const address of [
        "127.0.0.1",
        "172.30.33.5",
        "192.168.1.10",
        undefined,
      ]) {
        expect(crossSiteReason(ingress, [], address)).toBe("host");
      }
      expect(
        crossSiteReason({ host: "ha.example.com" }, [], "172.30.32.2"),
      ).toBe("host");
      expect(
        crossSiteReason(
          { host: "ha.example.com", "x-forwarded-for": "1.2.3.4" },
          [],
          "172.30.32.2",
        ),
      ).toBe("host");
      vi.stubEnv("SUPERVISOR_TOKEN", "");
      expect(crossSiteReason(ingress, [], "172.30.32.2")).toBe("host");
      vi.stubEnv("SUPERVISOR_TOKEN", undefined);
      expect(crossSiteReason(ingress, [], "172.30.32.2")).toBe("host");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("checks the origin against the host", () => {
    const host = "192.168.1.5:8482";
    expect(
      crossSiteReason({ host, origin: "http://192.168.1.5:8482" }, []),
    ).toBeUndefined();
    expect(
      crossSiteReason({ host: "[::1]:8482", origin: "http://[::1]:8482" }, []),
    ).toBeUndefined();
    expect(
      crossSiteReason({ host: "nas:443", origin: "https://nas" }, []),
    ).toBeUndefined();
    expect(crossSiteReason({ host, origin: "http://evil.example" }, [])).toBe(
      "origin",
    );
    expect(crossSiteReason({ host, origin: "null" }, [])).toBe("origin");
    const proxied = {
      host: "10.0.0.5:8482",
      origin: "https://matter.example.org",
    };
    expect(crossSiteReason(proxied, ["matter.example.org"])).toBeUndefined();
    expect(crossSiteReason(proxied, [])).toBe("origin");
    expect(crossSiteReason({ host, origin: "not a url" }, [])).toBe("origin");
  });

  it("names the rejected host or origin", () => {
    expect(crossSiteMessage("host", { host: "hamh.example.com" })).toBe(
      "Host hamh.example.com is not allowed, add it with --http-allowed-hosts",
    );
    expect(
      crossSiteMessage("origin", {
        origin: "https://matter.example.org:8443/<b>",
      }),
    ).toBe(
      "Origin matter.example.org:8443 is not allowed, add it with --http-allowed-hosts",
    );
    for (const origin of ["null", "not a url", "file:///etc", undefined]) {
      expect(crossSiteMessage("origin", { origin })).toBe(
        "Cross-site request blocked",
      );
    }
  });
});
