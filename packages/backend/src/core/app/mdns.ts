import * as os from "node:os";
import { Logger } from "@matter/general";
import { type Environment, Network } from "@matter/main";
import { MdnsService } from "@matter/main/protocol";
import { FilteredNetwork } from "./filtered-network.js";
import {
  DOCKER_NAME,
  describeInterface,
  inDockerRange,
  selectMdnsInterface,
} from "./select-mdns-interface.js";

const logger = Logger.get("Mdns");

export interface MdnsOptions {
  ipv4: boolean;
  networkInterface?: string;
  stripGlobalIpv6: boolean;
}

export function mdns(env: Environment, options: MdnsOptions) {
  if (options.stripGlobalIpv6) {
    env.set(Network, new FilteredNetwork());
  }
  warnAboutAdvertising(options);
  new MdnsService(env, {
    ipv4: options.ipv4,
    networkInterface: options.networkInterface,
  });
}

// Warn about advertised addresses controllers often cannot reach. A global IPv6
// can be stripped with mdns-strip-global-ipv6 (#361). matter.js answers each
// interface with its own addresses only, so Docker bridges are no fault.
export function warnAboutAdvertising(options: MdnsOptions) {
  const raw = os.networkInterfaces();
  const name = options.networkInterface;
  if (name && !raw[name]) {
    // matter.js only says "Unknown interface" deep inside a failed start
    logger.warn(
      `mdns-network-interface is set to "${name}", which does not exist on this host, so Matter mDNS cannot start. Interfaces: ${Object.keys(raw).join(", ")}.`,
    );
    return;
  }
  // only the configured interface is announced
  const choice = selectMdnsInterface(name ? { [name]: raw[name] } : raw);
  if (choice.hasGlobalIpv6 && !options.stripGlobalIpv6) {
    logger.warn(
      "Matter mDNS is advertising a global IPv6 address that controllers may not reach on the LAN, so devices can show No Response (#361). If devices work, nothing to do; otherwise turn on mdns_strip_global_ipv6 (add-on) or --mdns-strip-global-ipv6 (container).",
    );
  }
  // the OTBR route applies to the whole host, pinning does not change it
  const host = name ? selectMdnsInterface(raw) : choice;
  if (host.hasThreadInterface) {
    logger.warn(
      'An OpenThread/OTBR interface (wpan/otbr) is present. OTBR adds a kernel route for fc00::/7 via wpan0 that can send replies to controllers on another ULA VLAN into the Thread mesh, so devices show offline (#388). If that matches, add a more specific route, see "OTBR route trap across ULA VLANs" in the connectivity guide.',
    );
  }
  // a container sees its own eth0, host bridge names mean the LAN link is down
  const docker = choice.candidates.filter(
    (i) => !DOCKER_NAME.test(i.name) && i.ipv4.some(inDockerRange),
  );
  if (
    !name &&
    docker.length > 0 &&
    docker.length === choice.candidates.length
  ) {
    logger.warn(
      `Matter mDNS only finds Docker network addresses (${docker.map(describeInterface).join(", ")}), so HAMH seems to run without host networking and controllers on the LAN cannot find it. Matter needs host networking or a macvlan address. If your LAN really uses 172.16.0.0/12, ignore this line.`,
    );
  }
}
