import { NodeJsNetwork } from "@matter/nodejs";
import { isLinkLocalOrUla } from "./select-mdns-interface.js";

// Keep locally reachable IPv6 (link-local, ULA) and drop global IPv6, so a
// controller does not latch onto an address it cannot reach on the LAN (#361).
// Fall back to the full list if filtering would leave none, so an IPv6-only
// host still advertises something.
export function filterAdvertisedIpv6(ipV6: readonly string[]): string[] {
  const local = ipV6.filter(isLinkLocalOrUla);
  return local.length > 0 ? local : [...ipV6];
}

// matter advertises every interface IPv6 as an mDNS record, including a global
// address a controller cannot reach back on the LAN, so the operational session
// dies and devices show No Response (#361). Strip those from what gets
// advertised by filtering the single address source getIpMac.
export class FilteredNetwork extends NodeJsNetwork {
  override getIpMac(netInterface: string) {
    const details = super.getIpMac(netInterface);
    if (!details) return details;
    return { ...details, ipV6: filterAdvertisedIpv6(details.ipV6) };
  }
}
