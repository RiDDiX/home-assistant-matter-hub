import { describe, expect, it, vi } from "vitest";
import {
  advertisedAddressesChanged,
  collectAdvertisedAddresses,
  diffAdvertisedAddresses,
  MDNS_REFRESH_MAX_RETRIES,
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

  it("ignores container links when no interface is set", () => {
    const lan = { address: "192.168.1.10", family: "IPv4", internal: false };
    const before = ifaces({
      eth0: [lan],
      veth1a2b: [{ address: "fe80::a", family: "IPv6", internal: false }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    });
    const after = ifaces({
      eth0: [lan],
      veth9c8d: [{ address: "fe80::b", family: "IPv6", internal: false }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    });
    const a = collectAdvertisedAddresses(before);
    expect(a).toEqual(["192.168.1.10"]);
    expect(
      advertisedAddressesChanged(a, collectAdvertisedAddresses(after)),
    ).toBe(false);
    const moved = ifaces({
      eth0: [{ ...lan, address: "192.168.1.11" }],
      veth9c8d: [{ address: "fe80::b", family: "IPv6", internal: false }],
    });
    expect(
      advertisedAddressesChanged(a, collectAdvertisedAddresses(moved)),
    ).toBe(true);
  });

  it("watches container-named links when nothing else is there", () => {
    const lo = [{ address: "127.0.0.1", family: "IPv4", internal: true }];
    const before = ifaces({
      lo,
      cni0: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
    });
    const after = ifaces({
      lo,
      cni0: [{ address: "10.0.0.6", family: "IPv4", internal: false }],
    });
    expect(
      advertisedAddressesChanged(
        collectAdvertisedAddresses(before),
        collectAdvertisedAddresses(after),
      ),
    ).toBe(true);
  });

  it("keeps a configured interface even when it looks like a container link", () => {
    const set = ifaces({
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    });
    expect(collectAdvertisedAddresses(set, "docker0")).toEqual(["172.17.0.1"]);
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

  it("names the flipped address when the count stays the same", () => {
    const before = collectAdvertisedAddresses(oldPrefix);
    const after = collectAdvertisedAddresses(newPrefix);
    expect(after).toHaveLength(before.length);
    expect(advertisedAddressesChanged(before, after)).toBe(true);
    expect(diffAdvertisedAddresses(before, after)).toEqual({
      added: ["2601:ccc:d00:9::42"],
      removed: ["2601:aaa:b00:1::42"],
    });
  });
});

describe("runMdnsAddressWatchTick", () => {
  it("refreshes once per fabric and returns the new snapshot on change", async () => {
    const refresh = vi.fn(async () => {});
    const onChange = vi.fn();
    const { snapshot: next } = await runMdnsAddressWatchTick({
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
    const { snapshot: next } = await runMdnsAddressWatchTick({
      readInterfaces: () => oldPrefix,
      currentSnapshot: snapshot,
      fabrics: () => [{ id: 1 }, { id: 2 }],
      refresh,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(next).toBe(snapshot);
  });

  it("keeps refreshing and keeps the old snapshot when one fabric fails", async () => {
    const refresh = vi.fn(async (fabric: unknown) => {
      if ((fabric as { id: number }).id === 1) throw new Error("boom");
    });
    const onRefreshError = vi.fn();
    const old = collectAdvertisedAddresses(oldPrefix);
    const deps = {
      readInterfaces: () => newPrefix,
      currentSnapshot: old,
      fabrics: () => [{ id: 1 }, { id: 2 }],
      refresh,
      onRefreshError,
    };
    const first = await runMdnsAddressWatchTick(deps);
    expect(first).toEqual({ snapshot: old, failedRetries: 1 });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({ id: 2 });
    expect(onRefreshError).toHaveBeenCalledOnce();

    refresh.mockClear();
    await runMdnsAddressWatchTick({
      ...deps,
      currentSnapshot: first.snapshot,
      failedRetries: first.failedRetries,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stores the new snapshot once a partly failed fabric refreshes on the retry", async () => {
    let calls = 0;
    const refresh = vi.fn(async (fabric: unknown) => {
      calls++;
      if ((fabric as { id: number }).id === 1 && calls === 1) {
        throw new Error("boom");
      }
    });
    const old = collectAdvertisedAddresses(oldPrefix);
    const deps = {
      readInterfaces: () => newPrefix,
      currentSnapshot: old,
      fabrics: () => [{ id: 1 }, { id: 2 }],
      refresh,
    };
    const first = await runMdnsAddressWatchTick(deps);
    expect(first).toEqual({ snapshot: old, failedRetries: 1 });

    refresh.mockClear();
    const second = await runMdnsAddressWatchTick({
      ...deps,
      currentSnapshot: first.snapshot,
      failedRetries: first.failedRetries,
    });
    expect(refresh).toHaveBeenCalledWith({ id: 1 });
    expect(second).toEqual({
      snapshot: collectAdvertisedAddresses(newPrefix),
      failedRetries: 0,
    });
  });

  it("keeps the old snapshot and retries next tick when every fabric fails", async () => {
    const refresh = vi.fn(async (): Promise<void> => {
      throw new Error("boom");
    });
    const old = collectAdvertisedAddresses(oldPrefix);
    const deps = {
      readInterfaces: () => newPrefix,
      currentSnapshot: old,
      fabrics: () => [{ id: 1 }, { id: 2 }],
      refresh,
    };
    const first = await runMdnsAddressWatchTick(deps);
    expect(first).toEqual({ snapshot: old, failedRetries: 1 });

    refresh.mockClear();
    refresh.mockImplementation(async () => {});
    const second = await runMdnsAddressWatchTick({
      ...deps,
      currentSnapshot: first.snapshot,
      failedRetries: first.failedRetries,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(second).toEqual({
      snapshot: collectAdvertisedAddresses(newPrefix),
      failedRetries: 0,
    });
  });

  it("stores the snapshot after the retry cap when every fabric keeps failing", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("boom");
    });
    const onChange = vi.fn();
    const old = collectAdvertisedAddresses(oldPrefix);
    let state = { snapshot: old, failedRetries: 0 };
    for (let i = 0; i < MDNS_REFRESH_MAX_RETRIES; i++) {
      state = await runMdnsAddressWatchTick({
        readInterfaces: () => newPrefix,
        currentSnapshot: state.snapshot,
        failedRetries: state.failedRetries,
        fabrics: () => [{ id: 1 }],
        refresh,
        onChange,
      });
      expect(state).toEqual({ snapshot: old, failedRetries: i + 1 });
    }
    state = await runMdnsAddressWatchTick({
      readInterfaces: () => newPrefix,
      currentSnapshot: state.snapshot,
      failedRetries: state.failedRetries,
      fabrics: () => [{ id: 1 }],
      refresh,
      onChange,
    });
    expect(refresh).toHaveBeenCalledTimes(MDNS_REFRESH_MAX_RETRIES + 1);
    // the retries keep the old snapshot, so the change is reported once
    expect(onChange).toHaveBeenCalledOnce();
    expect(state).toEqual({
      snapshot: collectAdvertisedAddresses(newPrefix),
      failedRetries: 0,
    });
  });

  it("stores the snapshot when there are no fabrics to refresh", async () => {
    const { snapshot, failedRetries } = await runMdnsAddressWatchTick({
      readInterfaces: () => newPrefix,
      currentSnapshot: collectAdvertisedAddresses(oldPrefix),
      fabrics: () => [],
      refresh: vi.fn(async () => {}),
    });
    expect(snapshot).toEqual(collectAdvertisedAddresses(newPrefix));
    expect(failedRetries).toBe(0);
  });
});
