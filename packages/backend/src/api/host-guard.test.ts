import { describe, expect, it } from "vitest";
import { crossSiteReason } from "./host-guard.js";

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

  it("trusts proxy headers only from a trusted source", () => {
    const ingress = {
      host: "172.30.33.5:8099",
      origin: "https://ha.example.com",
      "x-ingress-path": "/api/hassio_ingress/abc",
    };
    expect(crossSiteReason(ingress, [], "172.30.32.2")).toBeUndefined();
    expect(crossSiteReason(ingress, [], "192.168.1.20")).toBe("origin");
    expect(
      crossSiteReason(
        { host: "evil.com", "x-forwarded-for": "1.2.3.4" },
        [],
        "192.168.1.20",
      ),
    ).toBe("host");
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
});
