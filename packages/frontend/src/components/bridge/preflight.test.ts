import { describe, expect, it } from "vitest";
import {
  connectivityDocsUrl,
  mapDiagnosticsToPreflightRows,
  type NetworkDiagnosticResult,
  summarizeChecks,
} from "./preflight.ts";

const result: NetworkDiagnosticResult = {
  timestamp: "2026-07-27T00:00:00.000Z",
  interfaces: [],
  checks: [
    { name: "external_interface", status: "pass", message: "1 interface" },
    {
      name: "mdns_interface_binding",
      status: "fail",
      message: 'Configured interface "eth9" not found',
      detail: "Available interfaces: eth0.",
    },
    {
      name: "mdns_ipv4",
      status: "warn",
      message: "IPv4 mDNS disabled",
    },
    {
      name: "ipv6_available",
      status: "warn",
      message: "No IPv6 addresses found",
    },
  ],
  matterConfig: { boundInterface: "eth9", ipv4Enabled: false },
};

describe("mapDiagnosticsToPreflightRows", () => {
  it("keeps only warn and fail checks", () => {
    const rows = mapDiagnosticsToPreflightRows(result);
    expect(rows.map((r) => r.name)).toEqual([
      "mdns_interface_binding",
      "mdns_ipv4",
      "ipv6_available",
    ]);
  });

  it("attaches the add-on option remediation for a mapped fail row", () => {
    const rows = mapDiagnosticsToPreflightRows(result);
    const fail = rows.find((r) => r.name === "mdns_interface_binding");
    expect(fail?.status).toBe("fail");
    expect(fail?.remediation.addonOption).toBe("mdns_network_interface");
    expect(fail?.remediation.containerFlag).toBe("--mdns-network-interface");
    expect(fail?.remediation.docsUrl).toBe(connectivityDocsUrl);
  });

  it("still gives a docs link when no option maps to the check", () => {
    const rows = mapDiagnosticsToPreflightRows(result);
    const ipv6 = rows.find((r) => r.name === "ipv6_available");
    expect(ipv6?.remediation.addonOption).toBeUndefined();
    expect(ipv6?.remediation.docsUrl).toBe(connectivityDocsUrl);
  });
});

describe("summarizeChecks", () => {
  it("counts checks by status", () => {
    expect(summarizeChecks(result)).toEqual({ pass: 1, warn: 2, fail: 1 });
  });
});
