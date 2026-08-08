import * as os from "node:os";
import express from "express";
import { selectMdnsInterface } from "../core/app/select-mdns-interface.js";

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

  router.get("/", (_, res) => {
    const result = runDiagnostics(mdnsInterface, mdnsIpv4);
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

function runDiagnostics(
  mdnsInterface: string | undefined,
  mdnsIpv4: boolean,
): NetworkDiagnosticResult {
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
      const suggestion = choice.selected
        ? `Bind to "${choice.selected}" via mdns-network-interface.`
        : `Set mdns-network-interface to your LAN interface (${choice.external
            .map((i) => i.name)
            .join(", ")}).`;
      checks.push({
        name: "multiple_interfaces",
        status: "warn",
        message: choice.suspicious
          ? "mDNS is advertising on Docker-internal or extra interfaces, which can make controllers show devices as offline"
          : `${choice.external.length} external interfaces detected without explicit binding`,
        detail: choice.suspicious
          ? `Matter bakes every interface address into its operational records, so controllers may pick an unreachable one. ${suggestion}`
          : `mDNS will broadcast on all interfaces. If controllers are on a specific VLAN, ${suggestion}`,
      });
    }
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
