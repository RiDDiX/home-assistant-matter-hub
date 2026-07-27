// Pure helpers for the wizard network preflight. Kept free of React so the
// diagnostics -> rows mapping stays easy to unit test.

export type CheckStatus = "pass" | "warn" | "fail";

export interface NetworkDiagnosticCheck {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface NetworkInterfaceInfo {
  name: string;
  ipv4: string[];
  ipv6: string[];
  mac: string;
  internal: boolean;
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

// The mDNS knobs are process start options (add-on config / CLI), not a runtime
// setting, so the panel can only tell the user what to change. It never writes.
export const connectivityDocsUrl =
  "https://riddix.github.io/home-assistant-matter-hub/guides/connectivity-issues";

export interface PreflightRemediation {
  // Add-on option the user edits to fix this check, if one maps cleanly.
  addonOption?: string;
  // Equivalent container CLI flag.
  containerFlag?: string;
  docsUrl: string;
}

export interface PreflightRow {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
  remediation: PreflightRemediation;
}

// Which start option addresses each diagnostic check.
const optionByCheck: Record<
  string,
  { addonOption: string; containerFlag: string }
> = {
  mdns_interface_binding: {
    addonOption: "mdns_network_interface",
    containerFlag: "--mdns-network-interface",
  },
  multiple_interfaces: {
    addonOption: "mdns_network_interface",
    containerFlag: "--mdns-network-interface",
  },
  mdns_ipv4: {
    addonOption: "mdns_disable_ipv4",
    containerFlag: "--mdns-disable-ipv4",
  },
};

export interface PreflightSummary {
  pass: number;
  warn: number;
  fail: number;
}

export function summarizeChecks(
  result: NetworkDiagnosticResult,
): PreflightSummary {
  const summary: PreflightSummary = { pass: 0, warn: 0, fail: 0 };
  for (const check of result.checks) {
    summary[check.status] += 1;
  }
  return summary;
}

// Only the warn/fail checks are actionable, so the preflight list shows those
// with their remediation. Passing checks fold into the summary counts.
export function mapDiagnosticsToPreflightRows(
  result: NetworkDiagnosticResult,
): PreflightRow[] {
  return result.checks
    .filter((check) => check.status !== "pass")
    .map((check) => {
      const option = optionByCheck[check.name];
      return {
        name: check.name,
        status: check.status,
        message: check.message,
        detail: check.detail,
        remediation: {
          addonOption: option?.addonOption,
          containerFlag: option?.containerFlag,
          docsUrl: connectivityDocsUrl,
        },
      };
    });
}
