import { describe, expect, it, vi } from "vitest";
import {
  advertisedAddressesChanged,
  collectAdvertisedAddresses,
  runMdnsAddressWatchTick,
} from "./mdns-address-watch.js";

type Iface = { address: string; family: string; internal: boolean };

function ifaces(map: Record<string, Iface[]>) {
  return map as unknown as ReturnType<
    typeof import("node:os").networkInterfaces
  >;
}

const oldPrefix = ifaces({
  lo: [{ address: "::1", family: "IPv6", internal: true }],
  eth0: [
    { address: "192.168.1.10", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
    { address: "2601:aaa:b00:1::42", family: "IPv6", internal: false },
  ],
});

const newPrefix = ifaces({
  lo: [{ address: "::1", family: "IPv6", internal: true }],
  eth0: [
    { address: "192.168.1.10", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
    { address: "2601:ccc:d00:9::42", family: "IPv6", internal: false },
  ],
});

describe("collectAdvertisedAddresses", () => {
  it("keeps the global IPv6 so a prefix change shows up", () => {
    const before = collectAdvertisedAddresses(oldPrefix);
    const after = collectAdvertisedAddresses(newPrefix);
    expect(before).toContain("2601:aaa:b00:1::42");
    expect(after).toContain("2601:ccc:d00:9::42");
    expect(advertisedAddressesChanged(before, after)).toBe(true);
  });

  it("strips global IPv6 so a prefix change no longer moves the set", () => {
    const before = collectAdvertisedAddresses(oldPrefix, undefined, true);
    const after = collectAdvertisedAddresses(newPrefix, undefined, true);
    expect(before).not.toContain("2601:aaa:b00:1::42");
    expect(before).toEqual(["192.168.1.10", "fe80::1"]);
    expect(advertisedAddressesChanged(before, after)).toBe(false);
  });

  it("honors the interface filter and ignores other interfaces", () => {
    const withDocker = ifaces({
      eth0: [{ address: "192.168.1.10", family: "IPv4", internal: false }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    });
    const dockerChanged = ifaces({
      eth0: [{ address: "192.168.1.10", family: "IPv4", internal: false }],
      docker0: [{ address: "172.17.0.9", family: "IPv4", internal: false }],
    });
    const a = collectAdvertisedAddresses(withDocker, "eth0");
    const b = collectAdvertisedAddresses(dockerChanged, "eth0");
    expect(a).toEqual(["192.168.1.10"]);
    expect(advertisedAddressesChanged(a, b)).toBe(false);
  });

  it("drops internal addresses", () => {
    expect(collectAdvertisedAddresses(oldPrefix)).not.toContain("::1");
  });
});

describe("collectAdvertisedAddresses with ipv4 disabled", () => {
  // Same IPv6, only the IPv4 lease moved.
  const v4Old = ifaces({
    eth0: [
      { address: "192.168.1.10", family: "IPv4", internal: false },
      { address: "2601:aaa:b00:1::42", family: "IPv6", internal: false },
    ],
  });
  const v4New = ifaces({
    eth0: [
      { address: "192.168.1.99", family: "IPv4", internal: false },
      { address: "2601:aaa:b00:1::42", family: "IPv6", internal: false },
    ],
  });

  it("ignores an IPv4-only change when mdns ipv4 is off (#417)", () => {
    const before = collectAdvertisedAddresses(v4Old, undefined, false, false);
    const after = collectAdvertisedAddresses(v4New, undefined, false, false);
    expect(before).not.toContain("192.168.1.10");
    expect(before).toEqual(["2601:aaa:b00:1::42"]);
    expect(advertisedAddressesChanged(before, after)).toBe(false);
  });

  it("still reports an IPv6 change when mdns ipv4 is off", () => {
    const before = collectAdvertisedAddresses(
      oldPrefix,
      undefined,
      false,
      false,
    );
    const after = collectAdvertisedAddresses(
      newPrefix,
      undefined,
      false,
      false,
    );
    expect(advertisedAddressesChanged(before, after)).toBe(true);
  });
});

describe("advertisedAddressesChanged", () => {
  it("is false for identical sets and fe80-only sets", () => {
    expect(advertisedAddressesChanged(["fe80::1"], ["fe80::1"])).toBe(false);
    expect(advertisedAddressesChanged(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("is true when an address is added or removed", () => {
    expect(advertisedAddressesChanged(["a"], ["a", "b"])).toBe(true);
    expect(advertisedAddressesChanged(["a", "b"], ["a"])).toBe(true);
    expect(advertisedAddressesChanged(["a"], ["b"])).toBe(true);
  });
});

describe("runMdnsAddressWatchTick", () => {
  it("refreshes once per fabric and returns the new snapshot on change", async () => {
    const refresh = vi.fn(async () => {});
    const onChange = vi.fn();
    const next = await runMdnsAddressWatchTick({
      readInterfaces: () => newPrefix,
      currentSnapshot: collectAdvertisedAddresses(oldPrefix),
      fabrics: () => [{ id: 1 }, { id: 2 }],
      refresh,
      onChange,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledOnce();
    expect(next).toEqual(collectAdvertisedAddresses(newPrefix));
  });

  it("does nothing when the set is unchanged", async () => {
    const refresh = vi.fn(async () => {});
    const snapshot = collectAdvertisedAddresses(oldPrefix);
    const next = await runMdnsAddressWatchTick({
      readInterfaces: () => oldPrefix,
      currentSnapshot: snapshot,
      fabrics: () => [{ id: 1 }, { id: 2 }],
      refresh,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(next).toBe(snapshot);
  });
});
