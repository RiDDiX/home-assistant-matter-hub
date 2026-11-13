import { describe, expect, it, vi } from "vitest";
import { crossSiteMessage, crossSiteReason } from "./host-guard.js";

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
