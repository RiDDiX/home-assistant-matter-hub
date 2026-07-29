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

// Simple set inequality between two collected snapshots.
export function advertisedAddressesChanged(
  prev: string[],
  curr: string[],
): boolean {
  if (prev.length !== curr.length) return true;
  const seen = new Set(prev);
  for (const a of curr) {
    if (!seen.has(a)) return true;
  }
  return false;
}

export interface MdnsAddressWatchDeps {
  readInterfaces: () => Interfaces;
  netInterface?: string;
  stripGlobalIpv6?: boolean;
  ipv4Enabled?: boolean;
  currentSnapshot: string[];
  fabrics: () => Iterable<unknown>;
  refresh: (fabric: unknown) => Promise<void>;
  onChange?: (prev: string[], curr: string[]) => void;
}

// One watcher tick: recompute the snapshot and, when it changed, refresh the
// operational advertisement for every fabric so matter.js re-runs its address
// lookup. Returns the snapshot to store (unchanged when nothing moved).
export async function runMdnsAddressWatchTick(
  deps: MdnsAddressWatchDeps,
): Promise<string[]> {
  const next = collectAdvertisedAddresses(
    deps.readInterfaces(),
    deps.netInterface,
    deps.stripGlobalIpv6,
    deps.ipv4Enabled,
  );
  if (!advertisedAddressesChanged(deps.currentSnapshot, next)) {
    return deps.currentSnapshot;
  }
  deps.onChange?.(deps.currentSnapshot, next);
  for (const fabric of deps.fabrics()) {
    await deps.refresh(fabric);
  }
  return next;
}
