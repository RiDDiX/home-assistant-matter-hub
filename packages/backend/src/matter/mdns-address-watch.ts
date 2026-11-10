import type * as os from "node:os";
import { filterAdvertisedIpv6 } from "../core/app/filtered-network.js";

// matter.js bakes the interface addresses into the operational mDNS records at
// first announcement and caches them. After an ISP IPv6 prefix change the old
// global AAAA keeps being advertised and the new one is never added, so a
// controller polling mDNS keeps the record alive and never re-CASEs (#415).
// This computes the address set that WOULD be advertised for the selected
// interface(s), honoring the same interface selection and strip-global-ipv6
// semantics the mdns setup uses, so a periodic check can spot the change.

type Interfaces = ReturnType<typeof os.networkInterfaces>;

// Collect the addresses mDNS would advertise, deduped and sorted so two
// snapshots compare stably. netInterface limits to one interface like
// mdns.networkInterface does; stripGlobalIpv6 drops global IPv6 per interface
// the way FilteredNetwork.getIpMac does. ipv4Enabled mirrors the mdns ipv4
// setting: when off matter.js emits no A records, so IPv4 churn must be
// ignored or it triggers false-positive refreshes (#417 parity).
export function collectAdvertisedAddresses(
  interfaces: Interfaces,
  netInterface?: string,
  stripGlobalIpv6?: boolean,
  ipv4Enabled = true,
): string[] {
  const names = netInterface ? [netInterface] : Object.keys(interfaces);
  const out = new Set<string>();
  for (const name of names) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    const usable = addrs.filter((a) => !a.internal);
    const ipv4 = ipv4Enabled
      ? usable.filter((a) => a.family === "IPv4").map((a) => a.address)
      : [];
    let ipv6 = usable.filter((a) => a.family === "IPv6").map((a) => a.address);
    if (stripGlobalIpv6) {
      ipv6 = filterAdvertisedIpv6(ipv6);
    }
    for (const a of ipv4) out.add(a);
    for (const a of ipv6) out.add(a);
  }
  return [...out].sort();
}

// Addresses only in curr (added) and only in prev (removed).
export function diffAdvertisedAddresses(
  prev: string[],
  curr: string[],
): { added: string[]; removed: string[] } {
  const before = new Set(prev);
  const after = new Set(curr);
  return {
    added: curr.filter((a) => !before.has(a)),
    removed: prev.filter((a) => !after.has(a)),
  };
}

// Simple set inequality between two collected snapshots.
export function advertisedAddressesChanged(
  prev: string[],
  curr: string[],
): boolean {
  const { added, removed } = diffAdvertisedAddresses(prev, curr);
  return added.length > 0 || removed.length > 0;
}

export interface MdnsAddressWatchDeps {
  readInterfaces: () => Interfaces;
  netInterface?: string;
  stripGlobalIpv6?: boolean;
  ipv4Enabled?: boolean;
  currentSnapshot: string[];
  // consecutive ticks that kept the old snapshot because every fabric failed
  failedRetries?: number;
  fabrics: () => Iterable<unknown>;
  refresh: (fabric: unknown) => Promise<void>;
  onChange?: (prev: string[], curr: string[]) => void;
  onRefreshError?: (fabric: unknown, error: unknown) => void;
}

export const MDNS_REFRESH_MAX_RETRIES = 3;

// One watcher tick: recompute the snapshot and, when it changed, refresh the
// operational advertisement for every fabric so matter.js re-runs its address
// lookup. Returns the snapshot to store (unchanged when nothing moved) and the
// retry count to pass into the next tick.
export async function runMdnsAddressWatchTick(
  deps: MdnsAddressWatchDeps,
): Promise<{ snapshot: string[]; failedRetries: number }> {
  const next = collectAdvertisedAddresses(
    deps.readInterfaces(),
    deps.netInterface,
    deps.stripGlobalIpv6,
    deps.ipv4Enabled,
  );
  if (!advertisedAddressesChanged(deps.currentSnapshot, next)) {
    return { snapshot: deps.currentSnapshot, failedRetries: 0 };
  }
  const retries = deps.failedRetries ?? 0;
  // a retry tick keeps the old snapshot, so it would report the same change
  if (retries === 0) {
    deps.onChange?.(deps.currentSnapshot, next);
  }
  let attempted = 0;
  let failed = 0;
  // one failing fabric must not skip the rest; only an all-fail tick retries
  for (const fabric of deps.fabrics()) {
    attempted++;
    try {
      await deps.refresh(fabric);
    } catch (e) {
      failed++;
      deps.onRefreshError?.(fabric, e);
    }
  }
  if (
    attempted > 0 &&
    failed === attempted &&
    retries < MDNS_REFRESH_MAX_RETRIES
  ) {
    return { snapshot: deps.currentSnapshot, failedRetries: retries + 1 };
  }
  return { snapshot: next, failedRetries: 0 };
}
