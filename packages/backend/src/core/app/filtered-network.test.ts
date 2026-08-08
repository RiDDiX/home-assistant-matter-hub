import { describe, expect, it } from "vitest";
import { filterAdvertisedIpv6 } from "./filtered-network.js";
import { isLinkLocalOrUla } from "./select-mdns-interface.js";

describe("isLinkLocalOrUla", () => {
  it("keeps link-local and ULA, drops global", () => {
    expect(isLinkLocalOrUla("fe80::1")).toBe(true);
    expect(isLinkLocalOrUla("FE80::1")).toBe(true);
    expect(isLinkLocalOrUla("fd00::1")).toBe(true);
    expect(isLinkLocalOrUla("fc00::1")).toBe(true);
    expect(isLinkLocalOrUla("2601:647:c000:d8e0::2190")).toBe(false);
    expect(isLinkLocalOrUla("2001:db8::1")).toBe(false);
  });
});

describe("filterAdvertisedIpv6", () => {
  it("drops the global IPv6 and keeps the link-local", () => {
    expect(
      filterAdvertisedIpv6([
        "2601:647:c000:d8e0::2190",
        "2601:647:c000:d8e0:4e2e:cadd:1666:afb3",
        "fe80::fac5:cb1c:5a1:41a9",
      ]),
    ).toEqual(["fe80::fac5:cb1c:5a1:41a9"]);
  });

  it("keeps link-local and ULA together", () => {
    expect(filterAdvertisedIpv6(["fe80::1", "fd00::1", "2001:db8::1"])).toEqual(
      ["fe80::1", "fd00::1"],
    );
  });

  it("falls back to the full list when only global addresses exist", () => {
    expect(filterAdvertisedIpv6(["2601::1", "2601::2"])).toEqual([
      "2601::1",
      "2601::2",
    ]);
  });
});
