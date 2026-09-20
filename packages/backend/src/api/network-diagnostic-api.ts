import * as net from "node:net";
import * as os from "node:os";
import express from "express";
import {
  describeInterface,
  selectMdnsInterface,
} from "../core/app/select-mdns-interface.js";

export interface NetworkInterfaceInfo {
  name: string;
  ipv4: string[];
  ipv6: string[];
  mac: string;
  internal: boolean;
}

export interface NetworkDiagnosticCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  detail?: string;
}

export interface NetworkDiagnosticResult {
  timestamp: string;
  interfaces: NetworkInterfaceInfo[];
  checks: NetworkDiagnosticCheck[];
  matterConfig: {
    boundInterface: string | null;
    ipv4Enabled: boolean;
  };
}

export function networkDiagnosticApi(
  mdnsInterface: string | undefined,
  mdnsIpv4: boolean,
): express.Router {
  const router = express.Router();

  router.get("/", async (_, res) => {
    const result = await runDiagnostics(mdnsInterface, mdnsIpv4);
    res.json(result);
  });

  return router;
}

function getNetworkInterfaces(): NetworkInterfaceInfo[] {
  const raw = os.networkInterfaces();
  const result: NetworkInterfaceInfo[] = [];

  for (const [name, addrs] of Object.entries(raw)) {
    if (!addrs) continue;
    const info: NetworkInterfaceInfo = {
      name,
      ipv4: [],
      ipv6: [],
      mac: addrs[0]?.mac ?? "00:00:00:00:00:00",
      internal: addrs[0]?.internal ?? false,
    };
    for (const addr of addrs) {
      if (addr.family === "IPv4") {
        info.ipv4.push(addr.address);
      } else if (addr.family === "IPv6") {
        info.ipv6.push(addr.address);
      }
    }
    result.push(info);
  }

  return result;
}

// Two setups tracked an Alexa pairing failure down to another service holding
// TCP 80 on the Home Assistant host: HA's own UI moved to port 80, and the
// Emulated Hue integration (#449, #478). Nothing in Matter uses port 80 and
// nobody has explained the mechanism, so this only reports what it sees.
// A refused connection means free, anything else means unknown, and only a
// completed connection warns.
async function isPort80Taken(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: 80 });
    const done = (taken: boolean) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function runDiagnostics(
  mdnsInterface: string | undefined,
  mdnsIpv4: boolean,
): Promise<NetworkDiagnosticResult> {
  const interfaces = getNetworkInterfaces();
  const checks: NetworkDiagnosticCheck[] = [];

  // Check 1: External (non-loopback) interfaces exist
  const external = interfaces.filter((i) => !i.internal);
  if (external.length === 0) {
    checks.push({
      name: "external_interface",
      status: "fail",
      message: "No external network interfaces found",
      detail:
        "Matter requires a network interface for mDNS discovery. Check Docker network mode (host networking recommended).",
    });
  } else {
    checks.push({
      name: "external_interface",
      status: "pass",
      message: `${external.length} external interface(s) available`,
      detail: external.map((i) => i.name).join(", "),
    });
  }

  // Check 2: IPv6 availability on external interfaces
  const ipv6Interfaces = external.filter((i) => i.ipv6.length > 0);
  if (ipv6Interfaces.length === 0) {
    checks.push({
      name: "ipv6_available",
      status: "warn",
      message: "No IPv6 addresses found on external interfaces",
      detail:
        "Matter primarily uses IPv6 for communication. Some controllers may require it. Ensure IPv6 is enabled on your network.",
    });
  } else {
    const linkLocal = ipv6Interfaces.filter((i) =>
      i.ipv6.some((addr) => addr.startsWith("fe80")),
    );
    const ula = ipv6Interfaces.filter((i) =>
      i.ipv6.some((addr) => addr.startsWith("fd")),
    );
    checks.push({
      name: "ipv6_available",
      status: "pass",
      message: `IPv6 available on ${ipv6Interfaces.length} interface(s)`,
      detail:
        `Link-local: ${linkLocal.length > 0 ? "yes" : "no"}, ` +
        `ULA (fd::): ${ula.length > 0 ? "yes" : "no"}`,
    });
  }

  // Check 3: IPv4 availability
  const ipv4Interfaces = external.filter((i) => i.ipv4.length > 0);
  if (ipv4Interfaces.length === 0) {
    checks.push({
      name: "ipv4_available",
      status: "warn",
      message: "No IPv4 addresses found on external interfaces",
      detail: "Some controllers use IPv4 for mDNS discovery.",
    });
  } else {
    checks.push({
      name: "ipv4_available",
      status: "pass",
      message: `IPv4 available on ${ipv4Interfaces.length} interface(s)`,
      detail: ipv4Interfaces
        .flatMap((i) => i.ipv4.map((addr) => `${i.name}: ${addr}`))
        .join(", "),
    });
  }

  // Check 4: Bound interface validation
  if (mdnsInterface) {
    const bound = interfaces.find((i) => i.name === mdnsInterface);
    if (!bound) {
      checks.push({
        name: "mdns_interface_binding",
        status: "fail",
        message: `Configured interface "${mdnsInterface}" not found`,
        detail: `Available interfaces: ${interfaces.map((i) => i.name).join(", ")}. Check the --mdns-network-interface option.`,
      });
    } else if (bound.internal) {
      checks.push({
        name: "mdns_interface_binding",
        status: "warn",
        message: `mDNS bound to internal/loopback interface "${mdnsInterface}"`,
        detail:
          "Controllers on the network cannot discover the bridge via loopback. Bind to an external interface.",
      });
    } else {
      checks.push({
        name: "mdns_interface_binding",
        status: "pass",
        message: `mDNS bound to "${mdnsInterface}"`,
        detail: `IPv4: ${bound.ipv4.join(", ") || "none"}, IPv6: ${bound.ipv6.join(", ") || "none"}`,
      });
    }
  } else {
    checks.push({
      name: "mdns_interface_binding",
      status: "pass",
      message: "mDNS bound to all interfaces (default)",
    });
  }

  // Check 5: IPv4 mDNS setting
  if (mdnsIpv4) {
    checks.push({
      name: "mdns_ipv4",
      status: "pass",
      message: "IPv4 mDNS enabled",
    });
  } else {
    checks.push({
      name: "mdns_ipv4",
      status: "warn",
      message: "IPv4 mDNS disabled (IPv6-only mode)",
      detail:
        "Some controllers (older Alexa, Google Home) may need IPv4 mDNS for discovery. Remove --mdns-disable-ipv4 (or the mdns_disable_ipv4 add-on option) to re-enable it.",
    });
  }

  // Check 6: Multiple external interfaces, often Docker-internal ones that make
  // controllers show devices as offline (#361).
  if (!mdnsInterface) {
    const choice = selectMdnsInterface(os.networkInterfaces());
    if (choice.suspicious || choice.external.length > 1) {
      const picked = choice.candidates.find((i) => i.name === choice.selected);
      const suggestion = picked
        ? `set mdns-network-interface to ${describeInterface(picked)}, your LAN interface.`
        : `set mdns-network-interface to your LAN interface, one of ${choice.candidates
            .map(describeInterface)
            .join(", ")}.`;
      checks.push({
        name: "multiple_interfaces",
        status: "warn",
        message: choice.suspicious
          ? "mDNS is advertising on Docker-internal or extra interfaces, which can make controllers show devices as offline"
          : `${choice.external.length} external interfaces detected without explicit binding`,
        detail: choice.suspicious
          ? `Matter puts every interface address into its records, so a controller may pick one it cannot reach. If your devices work, nothing to do. If a controller shows them offline, ${suggestion}`
          : `mDNS will broadcast on all interfaces. If controllers are on a specific VLAN, ${suggestion}`,
      });
    }
  }

  // Check 7: port 80 held on this host. Loopback covers host networking, the
  // advertised LAN address covers a container that has its own loopback.
  const probeHosts = [
    "127.0.0.1",
    ...(mdnsInterface
      ? (interfaces.find((i) => i.name === mdnsInterface)?.ipv4 ?? [])
      : (external.find((i) => i.ipv4.length > 0)?.ipv4 ?? [])
    ).slice(0, 1),
  ].filter((h, i, all) => all.indexOf(h) === i);
  const taken = await Promise.all(probeHosts.map(isPort80Taken));
  const busy = probeHosts.filter((_, i) => taken[i]);
  if (busy.length > 0) {
    checks.push({
      name: "port_80_in_use",
      status: "warn",
      message: "Something is listening on TCP port 80 on this host",
      detail:
        `Answering on ${busy.join(", ")}. Matter does not use port 80 and this breaks nothing by itself, so a reverse proxy or a UI on port 80 is not a misconfiguration. ` +
        "It is listed because two setups only got Alexa to finish pairing after freeing it, one with the Home Assistant UI moved to port 80, one with the Emulated Hue integration (#449, #478). " +
        "Nobody has explained why. If Alexa pairing keeps failing, stop whatever holds port 80 long enough to pair, then put it back.",
    });
  }

  return {
    timestamp: new Date().toISOString(),
    interfaces,
    checks,
    matterConfig: {
      boundInterface: mdnsInterface ?? null,
      ipv4Enabled: mdnsIpv4,
    },
  };
}
