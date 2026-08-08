import * as os from "node:os";
import { Logger } from "@matter/general";
import { type Environment, Network } from "@matter/main";
import { MdnsService } from "@matter/main/protocol";
import { FilteredNetwork } from "./filtered-network.js";
import { selectMdnsInterface } from "./select-mdns-interface.js";

const logger = Logger.get("Mdns");

export interface MdnsOptions {
  ipv4: boolean;
  networkInterface?: string;
  stripGlobalIpv6: boolean;
}

export function mdns(env: Environment, options: MdnsOptions) {
  if (options.stripGlobalIpv6) {
    env.set(Network, new FilteredNetwork());
  } else {
    warnAboutAdvertising(options);
  }
  new MdnsService(env, {
    ipv4: options.ipv4,
    networkInterface: options.networkInterface,
  });
}

// Warn about advertised addresses controllers often cannot reach. A global IPv6
// can be stripped with mdns-strip-global-ipv6 (#361); Docker-internal
// interfaces are narrowed with mdns-network-interface.
function warnAboutAdvertising(options: MdnsOptions) {
  const choice = selectMdnsInterface(os.networkInterfaces());
  if (choice.hasGlobalIpv6) {
    logger.warn(
      "Matter mDNS is advertising a global IPv6 address that controllers may not reach on the LAN, so devices can show No Response (#361). Set mdns-strip-global-ipv6 if devices stay unreachable.",
    );
  }
  if (options.networkInterface) {
    return;
  }
  const suggestion = choice.selected
    ? ` Likely LAN interface: ${choice.selected}.`
    : "";
  if (choice.hasThreadInterface) {
    logger.warn(
      `Matter mDNS is advertising on an OpenThread/OTBR interface (wpan/otbr) whose mesh-local address controllers cannot reach, so devices may show offline (#388). Set mdns-network-interface to your LAN interface.${suggestion}`,
    );
  }
  if (!choice.suspicious) {
    return;
  }
  const list = choice.external
    .map((i) => `${i.name} (${i.ipv4[0] ?? i.ipv6[0] ?? "?"})`)
    .join(", ");
  logger.warn(
    `Matter mDNS is advertising on several interfaces including likely Docker-internal ones, so controllers may show devices as offline (#361). Set mdns-network-interface to your LAN interface.${suggestion} Interfaces: ${list}.`,
  );
}
